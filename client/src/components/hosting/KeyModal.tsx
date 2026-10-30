import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, BookOpen, Bot, Check, Copy, Download, KeyRound, Plug } from 'lucide-react';
import type { ApiKey, ApiKeyCreate, ApiKeyCreated, ApiKeyDomainScope, ApiKeyGrantable, ApiKeyKind, ApiKeyPresetId, ApiKeyScope, ApiKeySiteScope, Domain, Site } from '@oblimint/shared';
import {
  API_KEY_PRESETS, API_KEY_SCOPES, apiKeyFormCutToGrantable, apiKeyGuide, apiKeyPreset, apiKeyPresetMatches, apiKeyPresetNeedsParents, apiKeyPresetScopes, matchApiKeyPreset,
  type ApiGuideLang,
} from '@oblimint/shared';
import { apiKeysApi } from '@/api/apiKeys.api';
import { sitesApi } from '@/api/sites.api';
import { domainsApi } from '@/api/domains.api';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { Modal } from '@/components/common/Modal';
import { MarkdownView } from '@/components/common/MarkdownView';
import { RightsChecklist } from '@/components/common/RightsChecklist';
import { copyText } from '@/utils/clipboard';
import { saveText } from '@/utils/download';
import { cn } from '@/utils/cn';
import { Pill, inputCls, labelCls, toastHostingError } from './hostingUi';

// The access key form (exported: the account tab today, the site page next —
// coherence plan D7), the one-time secret / connector modals and the API guide.

export const SCOPE_FALLBACK: Record<ApiKeyScope, [string, string]> = {
  'files.read': ['Read files', 'List, search and read (whole or by range) the files of its sites (code and data).'],
  'files.write': ['Write files', 'Create, replace, edit by exact replacements (with Read files), move, delete, extract archives in its sites. A write with an expected hash never overwrites a file changed meanwhile (SFTP included).'],
  'releases.publish': ['Publish', 'Publish the code as a new release (live) and roll back.'],
  'previews.manage': ['Live previews', 'Start, fetch and stop a preview of a release or of the staging; needs files.read too (staging: releases.publish).'],
  'sites.manage': ['Site settings', 'Change the settings of its sites: name, docroot, publish mode, PHP, environment variables, data paths, secondary runtimes.'],
  'sites.create': ['Create sites', 'Create sites in the account: they join the key automatically.'],
  'domains.subdomain': ['Subdomains', 'Attach to its sites subdomains of a domain already in the account (never a new domain): only under the domains given to the key or, for a key limited to some sites, under domains serving its sites alone. Removes only the ones it created, and not one that also serves a site outside the key.'],
  'logs.read': ['Read logs', 'Access / error / application logs of its sites, PHP errors grouped by release.'],
  'cron.manage': ['Cron jobs', 'Schedule commands of its sites (create, change, run, read the output).'],
  'routes.manage': ['Routes', 'Choose which of its sites (or runtime of a site) serves a path of a domain, e.g. example.com/uploads/; only on the domains given to the key or, for a key limited to some sites, on domains serving its sites alone. A route towards a site outside the key is never changed or removed.'],
  'databases.manage': ['Databases', 'Database servers of the account, databases and users (all of them for a key on every site, only its own otherwise); deletes only what it created.'],
};

// Presets of the key form (API_KEY_PRESETS, shared/src/apiKeys.ts): label, what it gives and leaves out.
const PRESET_FALLBACK: Record<ApiKeyPresetId, [string, string]> = {
  readonly: ['Read only', 'Reads the files and the logs of the chosen sites; writes nothing.'],
  update: ['Updates only', 'For a CI: writes the files, previews them and publishes them. No site setting (publish mode, environment, data paths), cron job, database, route or subdomain. On a site in automatic publication the writes go live at once, and so do the files written in the data area.'],
  site: ['Manage one site', 'Everything on exactly one site: files, publication, settings, logs, databases, cron jobs, routes of the domains serving it alone. No site creation, no subdomain, no domain given.'],
  multisite: ['Manage several sites', 'The same rights on several sites, or on every site. No domain given by default: give some below only if the key must route them.'],
  autonomous: ['Autonomous creation', 'Creates its own sites and works on them alone (no existing site): files, publication, settings, logs, databases, subdomains attached to its sites. The domains given below only serve as parents of its subdomains. No path route (it would also route the domains given, over the sites they serve); cron jobs (they run code) are to tick apart.'],
  all: ['Everything', 'Every right you may grant, on every site, and every domain if you may give them. Never: deleting a site, adding a root domain, users, other keys.'],
};

const EXPIRY_OPTIONS = [
  { id: 'never', days: null },
  { id: '7', days: 7 },
  { id: '30', days: 30 },
  { id: '90', days: 90 },
  { id: '365', days: 365 },
] as const;

function panelOrigin(): string {
  return window.location.origin;
}

export function KeyModal({ accountId, sites: sitesProp, domains: domainsProp, kind, initial, initialSiteIds, initialPreset, initialName, onClose, onSaved }: {
  accountId: number;
  /** Sites / domains of the account (loaded here when not given). */
  sites?: Site[];
  domains?: Domain[];
  kind: ApiKeyKind;
  initial: ApiKey | null;
  /** New key: sites ticked from the start (e.g. opened from a site page). */
  initialSiteIds?: number[];
  /** New key: the preset it starts with (« Updates only » by default), e.g. « Manage one site » for an AI agent. */
  initialPreset?: ApiKeyPresetId;
  /** New key: a suggested name. */
  initialName?: string;
  onClose: () => void;
  onSaved: (k: ApiKey | ApiKeyCreated) => void;
}) {
  const { t } = useTranslation();
  const [loadedSites, setLoadedSites] = useState<Site[]>([]);
  const [loadedDomains, setLoadedDomains] = useState<Domain[]>([]);
  useEffect(() => {
    let live = true;
    if (!sitesProp) sitesApi.list({ accountId }).then((l) => { if (live) setLoadedSites(l); }).catch(() => { /* none listed */ });
    // Domains of the account (to give to a key): none listed without the right to see them.
    if (!domainsProp) domainsApi.list({ accountId }).then((l) => { if (live) setLoadedDomains(l); }).catch(() => { /* none listed */ });
    return () => { live = false; };
  }, [accountId, sitesProp, domainsProp]);
  const sites = sitesProp ?? loadedSites;
  const domains = domainsProp ?? loadedDomains;
  const [name, setName] = useState(initial?.name ?? initialName ?? '');
  // A new key starts as « Updates only » or the given preset (cut down to the grantable scopes once they are known).
  const startPreset: ApiKeyPresetId = initialPreset ?? 'update';
  const [scopes, setScopes] = useState<Set<ApiKeyScope>>(new Set(initial?.scopes ?? apiKeyPresetScopes(apiKeyPreset(startPreset), API_KEY_SCOPES)));
  const [siteScope, setSiteScope] = useState<ApiKeySiteScope>(initial?.siteScope ?? apiKeyPreset(startPreset).siteScopes[0] ?? 'selected');
  const [siteIds, setSiteIds] = useState<Set<number>>(new Set(initial?.siteIds ?? initialSiteIds ?? []));
  const [domainScope, setDomainScope] = useState<ApiKeyDomainScope>(initial?.domainScope ?? 'selected');
  const [domainIds, setDomainIds] = useState<Set<number>>(new Set(initial?.domainIds ?? []));
  const [expiry, setExpiry] = useState<string>(initial ? 'keep' : '90');
  const [ips, setIps] = useState((initial?.allowedIps ?? []).join('\n'));
  const [busy, setBusy] = useState(false);
  const [grantable, setGrantable] = useState<ApiKeyGrantable | null>(null);
  const [preset, setPreset] = useState<ApiKeyPresetId | null>(initial ? null : startPreset);
  const [touched, setTouched] = useState(false);
  const toggle = <T,>(set: Set<T>, v: T) => { const s = new Set(set); if (s.has(v)) s.delete(v); else s.add(v); return s; };

  // What the user may grant (greyed scopes, presets). Unknown (error): nothing greyed, the server answers on save.
  useEffect(() => {
    let live = true;
    apiKeysApi.grantable(accountId).then((g) => { if (live) setGrantable(g); }).catch(() => { /* the save tells */ });
    return () => { live = false; };
  }, [accountId]);
  const grantList: readonly ApiKeyScope[] = grantable?.scopes ?? API_KEY_SCOPES;
  const canGrantDomains = grantable?.canGrantDomains ?? true;

  const createdSites = initial?.createdSiteIds ?? [];
  const presetState = {
    scopes: [...scopes], siteScope, siteCount: [...siteIds].filter((id) => !createdSites.includes(id)).length, domainScope, domainCount: domainIds.size,
  };
  // The chosen preset while the form still matches it, else the one it matches (an edited key), else « Custom ».
  const shownPreset: ApiKeyPresetId | null = preset && apiKeyPresetMatches(apiKeyPreset(preset), presetState, grantList, canGrantDomains)
    ? preset : matchApiKeyPreset(presetState, grantList, canGrantDomains);

  const applyPreset = (id: ApiKeyPresetId, grant: readonly ApiKeyScope[] = grantList, domainsOk = canGrantDomains) => {
    const p = apiKeyPreset(id);
    setScopes(new Set(apiKeyPresetScopes(p, grant)));
    const ss = p.siteScopes.includes(siteScope) ? siteScope : p.siteScopes[0];
    setSiteScope(ss);
    if (ss === 'selected') {
      // The sites the key created stay; the ones chosen by hand are cut down to the preset's maximum.
      let manual = [...siteIds].filter((x) => !createdSites.includes(x));
      if (p.maxSites !== null) manual = manual.slice(0, p.maxSites);
      if (!manual.length && p.minSites > 0 && sites.length === 1) manual = [sites[0].id];
      setSiteIds(new Set([...createdSites.filter((x) => siteIds.has(x)), ...manual]));
    }
    if (p.domains === 'all' && domainsOk) setDomainScope('all');
    else {
      setDomainScope('selected');
      if (p.domains !== 'pick' || !domainsOk) setDomainIds(new Set());
    }
    setPreset(id);
  };

  // A new key, once the grantable scopes are known: its preset is applied again while the user has not touched it;
  // touched before the answer, what the user does not hold is dropped (the save would be refused).
  useEffect(() => {
    if (!grantable || initial) return;
    if (!touched && preset) { applyPreset(preset, grantable.scopes, grantable.canGrantDomains); return; }
    const cut = apiKeyFormCutToGrantable({ scopes: [...scopes], domainScope, domainIds: [...domainIds] }, grantable);
    setScopes(new Set(cut.scopes));
    setDomainScope(cut.domainScope);
    setDomainIds(new Set(cut.domainIds));
  }, [grantable]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Any manual change of the rights, sites or domains (the shown preset follows). */
  const edit = <T,>(set: (v: T) => void) => (v: T) => { setTouched(true); set(v); };
  const setScopesM = edit(setScopes);
  const setSiteScopeM = edit(setSiteScope);
  const setSiteIdsM = edit(setSiteIds);
  const setDomainScopeM = edit(setDomainScope);
  const setDomainIdsM = edit(setDomainIds);

  const sitesHint = (() => {
    if (!shownPreset || siteScope !== 'selected') return null;
    const p = apiKeyPreset(shownPreset);
    if (presetState.siteCount >= p.minSites) return null;
    if (p.maxSites === 1) return t('apiKeys.presets.pickOneSite') || 'Choose its site below.';
    if (p.minSites >= 2) return t('apiKeys.presets.pickSites') || 'Choose two sites or more below, or every site.';
    return t('apiKeys.presets.pickSite') || 'Choose at least one site below.';
  })();
  // « Autonomous creation » without a parent domain: its subdomain right does nothing yet.
  const parentsHint = shownPreset && domains.length > 0 && apiKeyPresetNeedsParents(apiKeyPreset(shownPreset), presetState, grantList, canGrantDomains)
    ? (t('apiKeys.presets.pickParents') || 'Choose below the domains it will create its subdomains under.') : null;

  const save = async () => {
    const days = EXPIRY_OPTIONS.find((o) => o.id === expiry)?.days;
    const body: ApiKeyCreate = {
      ...(initial ? {} : { kind }),
      name: name.trim(),
      scopes: API_KEY_SCOPES.filter((s) => scopes.has(s)),
      siteScope,
      siteIds: siteScope === 'selected' ? [...siteIds] : [],
      // Domains only when changed: an edit by someone without the domain right keeps the grants in place.
      ...(!initial || domainScope !== initial.domainScope
        || [...domainIds].sort().join() !== [...initial.domainIds].sort().join()
        ? { domainScope, domainIds: domainScope === 'selected' ? [...domainIds] : [] } : {}),
      allowedIps: kind === 'connector' ? (initial?.allowedIps ?? []) : ips.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    };
    if (expiry !== 'keep') body.expiresAt = days ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
    setBusy(true);
    try {
      onSaved(initial ? await apiKeysApi.update(accountId, initial.id, body) : await apiKeysApi.create(accountId, body));
    } catch (err) {
      toastHostingError(t, err, t('apiKeys.saveFailed') || 'The key could not be saved');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} size="lg" icon={kind === 'connector' ? <Plug className="h-4 w-4 text-accent" /> : <KeyRound className="h-4 w-4 text-accent" />}
      title={initial ? (t('apiKeys.editTitle', { name: initial.name, defaultValue: 'Key {{name}}' }))
        : kind === 'connector' ? (t('apiKeys.connector.createTitle') || 'New Claude connector') : (t('apiKeys.createTitle') || 'New access key')}
      footer={(
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button loading={busy} disabled={!name.trim()} onClick={() => void save()}>{initial ? (t('common.save') || 'Save') : kind === 'connector' ? (t('apiKeys.connector.createButton') || 'Create the connector') : (t('apiKeys.create') || 'Create the key')}</Button>
        </div>
      )}>
      <div className="space-y-4">
        {kind === 'connector' && !initial && (
          <p className="rounded-lg bg-accent/5 p-2.5 text-xs text-text-secondary">
            {t('apiKeys.connector.formHint') || 'Choose what Claude may do. Whoever approves the connection lends their own rights, within these: a member without a right does not pass it on.'}
          </p>
        )}
        <div>
          <label className={labelCls}>{t('apiKeys.name') || 'Name'}</label>
          <input className={inputCls} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder={kind === 'connector' ? 'Claude' : 'Claude — blog'} />
        </div>
        <RightsChecklist<ApiKeyScope, ApiKeyPresetId>
          presetsLabel={t('apiKeys.presets.label') || 'Preset'}
          presets={API_KEY_PRESETS.map((p) => ({
            id: p.id,
            label: t(`apiKeys.presets.${p.id}.label`) || PRESET_FALLBACK[p.id][0],
            // A preset whose rights the user holds none of gives nothing: not offered.
            disabled: !apiKeyPresetScopes(p, grantList).length,
          }))}
          activePreset={shownPreset}
          onPreset={(id) => applyPreset(id)}
          customLabel={t('apiKeys.presets.custom.label') || 'Custom'}
          presetHint={(
            <>
              {shownPreset ? (t(`apiKeys.presets.${shownPreset}.hint`) || PRESET_FALLBACK[shownPreset][1])
                : (t('apiKeys.presets.custom.hint') || 'Rights, sites and domains chosen one by one.')}
              {sitesHint && <span className="ml-1 text-amber-400">{sitesHint}</span>}
              {parentsHint && <span className="ml-1 text-amber-400">{parentsHint}</span>}
            </>
          )}
          label={t('apiKeys.rights') || 'Rights'}
          items={API_KEY_SCOPES.map((sc) => ({ id: sc, label: t(`apiKeys.scopes.${sc}.label`) || SCOPE_FALLBACK[sc][0], hint: t(`apiKeys.scopes.${sc}.hint`) || SCOPE_FALLBACK[sc][1] }))}
          value={scopes}
          onChange={(next) => setScopesM(new Set(next))}
          grantable={grantList}
          notGrantableHint={t('apiKeys.notHeldHint') || 'You do not hold this right on the account: you cannot grant it.'}
          footer={t('apiKeys.neverHint') || 'Never granted to a key: deleting a site, a database it did not create or a database server, adding a root domain, other accounts, users.'}
        />
        <div>
          <label className={labelCls}>{t('apiKeys.sites') || 'Sites'}</label>
          <div className="flex flex-wrap gap-3 text-sm">
            <label className="flex items-center gap-1.5"><input type="radio" checked={siteScope === 'selected'} onChange={() => setSiteScopeM('selected')} className="accent-accent" />{t('apiKeys.selectedSites') || 'Only the sites below (+ the ones it creates)'}</label>
            <label className="flex items-center gap-1.5"><input type="radio" checked={siteScope === 'all'} onChange={() => setSiteScopeM('all')} className="accent-accent" />{t('apiKeys.allSites') || 'Every site of the account'}</label>
          </div>
          {siteScope === 'selected' && (
            <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-lg bg-bg-tertiary/40 p-2">
              {!sites.length && <p className="text-xs text-text-muted">{t('apiKeys.noSites') || 'No site yet.'}</p>}
              {sites.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={siteIds.has(s.id)} disabled={initial?.createdSiteIds.includes(s.id)} onChange={() => setSiteIdsM(toggle(siteIds, s.id))} className="accent-accent" />
                  <span className="text-text-primary">{s.primaryDomain || s.name}</span>
                  <span className="font-mono text-[11px] text-text-muted">{s.slug}</span>
                  {initial?.createdSiteIds.includes(s.id) && <Pill tone="blue">{t('apiKeys.createdByKey') || 'created by the key'}</Pill>}
                </label>
              ))}
            </div>
          )}
        </div>
        <div>
          <label className={labelCls}>{t('apiKeys.domains') || 'Domains'}</label>
          <p className="mb-2 text-[11px] text-text-muted">{t('apiKeys.domainsHint') || 'With the Routes right, the key may decide which of its sites serves these domains (or a path of them) — even a domain that serves nothing yet; with the Subdomains right, it attaches subdomains under them. A key valid for every site only works on the domains given here. Without a domain here, a key limited to some sites works only on the domains serving its sites alone (subdomains under those same domains). A route towards a site outside the key is never changed or removed. Giving domains needs the domain management right.'}</p>
          {!canGrantDomains && <p className="mb-2 text-[11px] text-amber-400">{t('apiKeys.domainsNotHeld') || 'You do not hold the domain management right on the account: you cannot give domains to a key.'}</p>}
          <div className="flex flex-wrap gap-3 text-sm">
            <label className="flex items-center gap-1.5"><input type="radio" checked={domainScope === 'selected'} onChange={() => setDomainScopeM('selected')} className="accent-accent" />{t('apiKeys.selectedDomains') || 'Only the domains below'}</label>
            <label className={cn('flex items-center gap-1.5', !canGrantDomains && domainScope !== 'all' && 'cursor-not-allowed opacity-50')}><input type="radio" checked={domainScope === 'all'} disabled={!canGrantDomains && domainScope !== 'all'} onChange={() => setDomainScopeM('all')} className="accent-accent" />{t('apiKeys.allDomains') || 'Every domain of the account'}</label>
          </div>
          {domainScope === 'selected' && (
            <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-lg bg-bg-tertiary/40 p-2">
              {!domains.length && <p className="text-xs text-text-muted">{t('apiKeys.noDomains') || 'No domain in this account.'}</p>}
              {domains.map((d) => {
                const own = initial?.createdDomainIds.includes(d.id) ?? false;
                return (
                  <label key={d.id} className={cn('flex items-center gap-2 text-sm', !own && !canGrantDomains && !domainIds.has(d.id) && 'opacity-50')}>
                    <input type="checkbox" checked={own || domainIds.has(d.id)} disabled={own || (!canGrantDomains && !domainIds.has(d.id))} onChange={() => setDomainIdsM(toggle(domainIds, d.id))} className="accent-accent" />
                    <span className="font-mono text-text-primary">{d.name}</span>
                    {own && <Pill tone="blue">{t('apiKeys.createdByKey') || 'created by the key'}</Pill>}
                  </label>
                );
              })}
            </div>
          )}
        </div>
        <div className={cn('grid gap-3', kind !== 'connector' && 'sm:grid-cols-2')}>
          <div>
            <label className={labelCls}>{t('apiKeys.expiry') || 'Expiry'}</label>
            <select className={inputCls} value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              {initial && <option value="keep">{t('apiKeys.keepExpiry') || 'Unchanged'}</option>}
              <option value="7">{t('apiKeys.days', { count: 7, defaultValue: '{{count}} days' })}</option>
              <option value="30">{t('apiKeys.days', { count: 30, defaultValue: '{{count}} days' })}</option>
              <option value="90">{t('apiKeys.days', { count: 90, defaultValue: '{{count}} days' })}</option>
              <option value="365">{t('apiKeys.oneYear') || '1 year'}</option>
              <option value="never">{t('apiKeys.never') || 'never'}</option>
            </select>
          </div>
          {kind !== 'connector' && (
            <div>
              <label className={labelCls}>{t('apiKeys.allowedIps') || 'Allowed addresses (optional)'}</label>
              <textarea className={cn(inputCls, 'h-[38px] min-h-[38px] resize-y font-mono text-xs')} value={ips} onChange={(e) => setIps(e.target.value)} placeholder="203.0.113.0/24" />
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  return (
    <div>
      <div className="mb-1 text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted">{label}</div>
      <div className="flex items-start gap-2 rounded-lg bg-bg-primary p-2.5">
        <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[12px] text-text-primary">{text}</code>
        <IconButton size="sm" label={t('common.copy') || 'Copy'} icon={done ? <Check className="h-4 w-4 text-status-up" /> : <Copy className="h-4 w-4" />}
          onClick={() => { void copyText(text).then((ok) => { if (ok) { setDone(true); setTimeout(() => setDone(false), 1500); } }); }} />
      </div>
    </div>
  );
}

export function CreatedKeyModal({ created, onClose, onGuide }: { created: ApiKeyCreated; onClose: () => void; onGuide: () => void }) {
  if (created.kind === 'connector') return <ConnectorCreatedModal created={created} onClose={onClose} />;
  return <KeyCreatedModal created={created} onClose={onClose} onGuide={onGuide} />;
}

function ConnectorCreatedModal({ created, onClose }: { created: ApiKeyCreated; onClose: () => void }) {
  const { t } = useTranslation();
  const steps = [
    t('apiKeys.connector.step1') || 'In Claude (claude.ai or the Desktop app): Settings → Connectors → Add custom connector.',
    t('apiKeys.connector.step2') || 'Name: Oblimint. Remote MCP server URL: the address below.',
    t('apiKeys.connector.step3') || 'Open « Advanced settings » and paste the OAuth Client ID and Client Secret.',
    t('apiKeys.connector.step4') || 'Click Add, then Connect: this panel opens and asks you to approve. The connector then works in every Claude app of your Claude account.',
  ];
  return (
    <Modal open onClose={onClose} size="lg" closeOnBackdrop={false} icon={<Plug className="h-4 w-4 text-accent" />}
      title={t('apiKeys.connector.createdTitle', { name: created.name, defaultValue: 'Claude connector "{{name}}"' })}
      footer={<div className="flex justify-end"><Button onClick={onClose}>{t('apiKeys.savedIt') || 'I saved it'}</Button></div>}>
      <div className="space-y-4">
        <p className="flex items-start gap-2 rounded-lg bg-amber-400/10 p-2.5 text-xs text-amber-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {t('apiKeys.connector.secretOnce') || 'The client secret is shown only now. Lost? Generate a new one from the list (the connections in place stay).'}
        </p>
        <ol className="list-decimal space-y-1 pl-5 text-xs text-text-secondary">
          {steps.map((s) => <li key={s}>{s}</li>)}
        </ol>
        <CopyBlock label={t('apiKeys.connector.url') || 'Remote MCP server URL'} text={`${panelOrigin()}/mcp`} />
        <CopyBlock label="OAuth Client ID" text={created.oauthClientId ?? ''} />
        <CopyBlock label="OAuth Client Secret" text={created.clientSecret ?? ''} />
        <p className="text-[11px] text-text-muted">
          {t('apiKeys.connector.teamHint') || 'Claude Team / Enterprise: an owner adds the connector for the organization, then each member connects with their own panel account.'}
        </p>
      </div>
    </Modal>
  );
}

function KeyCreatedModal({ created, onClose, onGuide }: { created: ApiKeyCreated; onClose: () => void; onGuide: () => void }) {
  const { t } = useTranslation();
  const origin = panelOrigin();
  const mcp = `claude mcp add --transport http oblimint ${origin}/mcp --header "Authorization: Bearer ${created.key}"`;
  const curl = `curl -H "Authorization: Bearer ${created.key}" ${origin}/api/v1/sites`;
  return (
    <Modal open onClose={onClose} size="lg" closeOnBackdrop={false} icon={<Bot className="h-4 w-4 text-accent" />}
      title={t('apiKeys.createdTitle', { name: created.name, defaultValue: 'Key "{{name}}" created' })}
      footer={<div className="flex justify-end"><Button onClick={onClose}>{t('apiKeys.savedIt') || 'I saved it'}</Button></div>}>
      <div className="space-y-4">
        <p className="flex items-start gap-2 rounded-lg bg-amber-400/10 p-2.5 text-xs text-amber-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {t('apiKeys.shownOnce') || 'This key is shown only now: copy it somewhere safe. It cannot be displayed again (revoke it and create another one if lost).'}
        </p>
        <CopyBlock label={t('apiKeys.theKey') || 'Key'} text={created.key ?? ''} />
        <CopyBlock label={t('apiKeys.claudeCode') || 'Claude Code (MCP)'} text={mcp} />
        <CopyBlock label="curl" text={curl} />
        <p className="text-[11px] text-text-muted">
          {t('apiKeys.docHint') || 'API: /api/v1 (sites, files, publish, releases, logs). MCP: the same tools for an AI agent. Every action is logged in the audit log with the key name.'}
        </p>
        <button type="button" onClick={onGuide} className="flex items-center gap-1.5 text-xs text-accent hover:underline">
          <BookOpen className="h-3.5 w-3.5" />{t('apiKeys.guideHint') || 'Read the guide, or download it to give it to your agent'}
        </button>
      </div>
    </Modal>
  );
}

export function ApiGuideModal({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const [lang, setLang] = useState<ApiGuideLang>(i18n.language.startsWith('fr') ? 'fr' : 'en');
  const [copied, setCopied] = useState(false);
  const md = apiKeyGuide(lang, panelOrigin());
  const download = async () => {
    if (!(await saveText(md, `oblimint-api-guide-${lang}.md`, 'text/markdown;charset=utf-8'))) toast.error(t('apiKeys.guideDownloadFailed') || 'The download failed');
  };
  return (
    <Modal open onClose={onClose} size="2xl" icon={<BookOpen className="h-4 w-4 text-accent" />}
      title={t('apiKeys.guideTitle') || 'API & AI agent guide'}
      footer={(
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-1">
            {(['fr', 'en'] as const).map((l) => (
              <button key={l} type="button" onClick={() => setLang(l)}
                className={cn('rounded-md px-2 py-1 font-mono text-xs uppercase', lang === l ? 'bg-accent/15 text-accent' : 'text-text-muted hover:text-text-primary')}>{l}</button>
            ))}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => { void copyText(md).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }); }}>
              {copied ? <Check className="mr-1 h-3.5 w-3.5 text-status-up" /> : <Copy className="mr-1 h-3.5 w-3.5" />}{t('common.copy') || 'Copy'}
            </Button>
            <Button onClick={() => void download()}><Download className="mr-1 h-3.5 w-3.5" />{t('apiKeys.guideDownload') || 'Download (.md)'}</Button>
          </div>
        </div>
      )}>
      <p className="mb-4 rounded-lg bg-accent/5 p-2.5 text-xs text-text-secondary">
        {t('apiKeys.guideIntro') || 'Give this file to your AI agent (e.g. "read this guide, then work on my site"): it explains how to connect with a key, develop in staging, publish at the end and roll back. Agents connected through MCP can also read it with the get_guide tool.'}
      </p>
      <MarkdownView source={md} />
    </Modal>
  );
}
