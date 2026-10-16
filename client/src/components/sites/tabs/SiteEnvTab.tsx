import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Eye, EyeOff, FileUp, KeyRound, Lock, Plus, Save, Trash2 } from 'lucide-react';
import type { SiteEnvVar } from '@oblimint/shared';
import { SITE_ENV_NAME_RE, reservedEnvName } from '@oblimint/shared';
import apiClient from '@/api/client';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { usePrompt } from '@/components/common/ConfirmDialog';
import { Card, inputCls, toastHostingError } from '@/components/hosting/hostingUi';
import { useHostingMe } from '@/store/hostingStore';
import { cn } from '@/utils/cn';
import type { SiteTabProps } from './types';

// Environment variables of the site: secrets out of the code (PHP getenv()
// / $_SERVER, cron, CLI). The whole set is saved at once; a change restarts
// the site's containers. A secret is write-only (left empty = unchanged).

interface Row {
  key: number;
  name: string;
  value: string;
  secret: boolean;
  /** Existing secret: its value is kept unless a new one is typed. */
  stored: boolean;
  reveal: boolean;
}

let seq = 0;
const toRows = (vars: SiteEnvVar[]): Row[] => vars.map((v) => ({ key: seq++, name: v.name, value: v.value ?? '', secret: v.secret, stored: v.secret, reveal: false }));

/** KEY=VALUE lines of a .env (comments, export prefix and surrounding quotes handled). */
export function parseDotEnv(text: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out.push({ name: m[1], value: v });
  }
  return out;
}

export function SiteEnvTab({ site }: SiteTabProps) {
  const { t } = useTranslation();
  const prompt = usePrompt();
  const { can } = useHostingMe();
  const manage = can('sites.manage', site.accountId);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!manage) return;
    apiClient.get<{ data: SiteEnvVar[] }>(`/sites/${site.id}/env`)
      .then((r) => setRows(toRows(r.data.data)))
      .catch((err) => { toastHostingError(t, err, t('siteEnv.loadFailed') || 'The variables could not be loaded'); setRows([]); });
  }, [manage, site.id, t]);

  if (!manage) return <Card><p className="text-sm text-text-muted">{t('siteEnv.noRight') || 'Managing the variables needs the site settings right.'}</p></Card>;
  if (!rows) return <div className="flex justify-center p-8"><LoadingSpinner /></div>;

  const update = (key: number, patch: Partial<Row>) => { setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r))); setDirty(true); };
  const problem = (r: Row): string | null => {
    if (!r.name) return t('siteEnv.nameRequired') || 'Name required';
    if (!SITE_ENV_NAME_RE.test(r.name)) return t('siteEnv.nameInvalid') || 'Letters, digits and _ (not starting with a digit)';
    if (reservedEnvName(r.name)) return t('siteEnv.nameReserved') || 'Reserved by the platform';
    if (rows.filter((x) => x.name === r.name).length > 1) return t('siteEnv.nameDuplicate') || 'Duplicate name';
    if (!r.stored && r.value === '' && r.secret) return t('siteEnv.valueRequired') || 'A secret needs a value';
    return null;
  };
  const invalid = rows.some((r) => problem(r) !== null);

  const importEnv = async () => {
    const text = await prompt({ title: t('siteEnv.importTitle') || 'Import a .env', message: t('siteEnv.importHint') || 'Paste KEY=VALUE lines: existing names are replaced, the others added.', multiline: true, plain: true });
    if (!text) return;
    const parsed = parseDotEnv(text);
    if (!parsed.length) { toast.error(t('siteEnv.importEmpty') || 'No KEY=VALUE line found'); return; }
    const next = [...rows];
    for (const p of parsed) {
      const i = next.findIndex((r) => r.name === p.name);
      const secret = /SECRET|PASSWORD|PASS|TOKEN|KEY|PRIVATE/i.test(p.name);
      if (i >= 0) next[i] = { ...next[i], value: p.value, stored: false };
      else next.push({ key: seq++, name: p.name, value: p.value, secret, stored: false, reveal: false });
    }
    setRows(next);
    setDirty(true);
    toast.success(t('siteEnv.imported', { count: parsed.length, defaultValue: '{{count}} variable(s) imported: review, then save' }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const body = { vars: rows.map((r) => ({ name: r.name, secret: r.secret, ...(r.stored && r.value === '' ? {} : { value: r.value }) })) };
      const res = await apiClient.put<{ data: { vars: SiteEnvVar[]; changed: boolean } }>(`/sites/${site.id}/env`, body);
      setRows(toRows(res.data.data.vars));
      setDirty(false);
      toast.success(res.data.data.changed ? (t('siteEnv.saved') || 'Saved: the site restarts with the new variables') : (t('siteEnv.unchanged') || 'Nothing changed'));
    } catch (err) {
      toastHostingError(t, err, t('siteEnv.saveFailed') || 'The variables could not be saved');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card
        icon={<KeyRound size={14} className="text-accent" />}
        title={t('siteEnv.title') || 'Environment variables'}
        actions={(
          <>
            <Button size="sm" variant="secondary" onClick={() => void importEnv()}><FileUp className="mr-1 h-3.5 w-3.5" />{t('siteEnv.import') || 'Import a .env'}</Button>
            <Button size="sm" variant="secondary" onClick={() => { setRows([...rows, { key: seq++, name: '', value: '', secret: false, stored: false, reveal: true }]); setDirty(true); }}>
              <Plus className="mr-1 h-3.5 w-3.5" />{t('siteEnv.add') || 'Add'}
            </Button>
            <Button size="sm" disabled={!dirty || invalid} loading={saving} onClick={() => void save()}><Save className="mr-1 h-3.5 w-3.5" />{t('common.save') || 'Save'}</Button>
          </>
        )}
      >
        <p className="text-xs text-text-muted">
          {t('siteEnv.intro') || 'Given to the site at start-up: getenv(\'NAME\') or $_SERVER[\'NAME\'] in PHP, also in the cron jobs. The right place for API keys and passwords: never in the code, never in the public folder. Saving restarts the site (a few seconds).'}
        </p>
        {rows.length === 0 ? (
          <p className="mt-4 text-sm text-text-muted">{t('siteEnv.empty') || 'No variable yet.'}</p>
        ) : (
          <div className="mt-4 space-y-2">
            {rows.map((r) => {
              const err = problem(r);
              return (
                <div key={r.key} className="grid grid-cols-1 gap-2 rounded-lg bg-bg-primary/40 p-2 sm:grid-cols-[minmax(160px,1fr)_2fr_auto]">
                  <div>
                    <input
                      className={cn(inputCls, 'font-mono text-[13px]', err && r.name && 'ring-1 ring-status-down')}
                      value={r.name}
                      placeholder="TWITCH_CLIENT_ID"
                      spellCheck={false}
                      onChange={(e) => update(r.key, { name: e.target.value.trim() })}
                    />
                    {err && <p className="mt-0.5 text-[11px] text-status-down">{err}</p>}
                  </div>
                  <div className="relative">
                    <input
                      className={cn(inputCls, 'pr-9 font-mono text-[13px]')}
                      type={r.secret && !r.reveal ? 'password' : 'text'}
                      value={r.value}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={r.stored ? (t('siteEnv.keepSecret') || '•••••• (unchanged)') : (t('siteEnv.value') || 'value')}
                      onChange={(e) => update(r.key, { value: e.target.value })}
                    />
                    {r.secret && (
                      <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary" onClick={() => update(r.key, { reveal: !r.reveal })}>
                        {r.reveal ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <label className={cn('inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs', r.secret ? 'bg-amber-400/10 text-amber-400' : 'text-text-muted hover:bg-bg-hover')}>
                      <input type="checkbox" className="hidden" checked={r.secret} onChange={(e) => update(r.key, { secret: e.target.checked })} />
                      <Lock size={13} />{t('siteEnv.secret') || 'Secret'}
                    </label>
                    <IconButton size="sm" variant="danger" label={t('common.delete') || 'Delete'} icon={<Trash2 className="h-4 w-4" />}
                      onClick={() => { setRows(rows.filter((x) => x.key !== r.key)); setDirty(true); }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
