import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Eye, EyeOff, FileUp, KeyRound, Lock, Plus, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { usePrompt } from '@/components/common/ConfirmDialog';
import { Card, inputCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import {
  emptyRow, importRows, parseDotEnv, rowProblem, saveBody, siteGuessSecret, toRows, type EnvProblem, type EnvRow, type EnvVarSave, type EnvVarView,
} from './envVarsLogic';

/** What the parent can do with the rows (extra actions: example import…). */
export interface EnvVarsApi {
  rows: EnvRow[];
  /** Replaces the rows (marks the form dirty). */
  setRows: (rows: EnvRow[]) => void;
}

/**
 * Environment variables editor (one row per variable: name | value, Secret,
 * eye, bin; Import a .env, Add, Save). Extracted from the site variables
 * (SiteEnvTab) and shared with the application .env. A secret is write-only
 * (left empty = unchanged); unchecking Secret on a stored one needs a new value.
 * `vars` null = loading. `onSave` returns the variables as stored, or null on
 * failure (the parent shows the error).
 */
export function EnvVarsEditor({
  vars, onSave, title, intro, emptyText, reserved, guessSecret = siteGuessSecret, extraActions, renderNotice, saveExtra,
}: {
  vars: EnvVarView[] | null;
  onSave: (body: EnvVarSave[]) => Promise<EnvVarView[] | null>;
  title?: string;
  intro: ReactNode;
  emptyText?: string;
  /** Names the platform keeps (sites). */
  reserved?: (name: string) => boolean;
  /** Secret proposed for an imported name. */
  guessSecret?: (name: string) => boolean;
  extraActions?: (api: EnvVarsApi) => ReactNode;
  /** Shown above the rows (names currently in the form). */
  renderNotice?: (names: string[], api: EnvVarsApi) => ReactNode;
  /** Extra save button (e.g. save and deploy): receives the save of the form. */
  saveExtra?: (save: () => Promise<boolean>, state: { dirty: boolean; invalid: boolean; saving: boolean }) => ReactNode;
}) {
  const { t } = useTranslation();
  const prompt = usePrompt();
  const [rows, setRowsState] = useState<EnvRow[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (vars === null) return;
    setRowsState(toRows(vars));
    setDirty(false);
  }, [vars]);

  if (!rows) return <div className="flex justify-center p-8"><LoadingSpinner /></div>;

  const setRows = (next: EnvRow[]) => { setRowsState(next); setDirty(true); };
  const api: EnvVarsApi = { rows, setRows };
  const update = (key: number, patch: Partial<EnvRow>) => setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const messages: Record<EnvProblem, string> = {
    nameRequired: t('siteEnv.nameRequired') || 'Name required',
    nameInvalid: t('siteEnv.nameInvalid') || 'Letters, digits and _ (not starting with a digit)',
    nameReserved: t('siteEnv.nameReserved') || 'Reserved by the platform',
    nameDuplicate: t('siteEnv.nameDuplicate') || 'Duplicate name',
    valueRequired: t('siteEnv.valueRequired') || 'A secret needs a value',
    unsecretValueRequired: t('siteEnv.unsecretValueRequired') || 'Type a new value to make it visible (the stored one stays hidden)',
  };
  const problem = (r: EnvRow): string | null => {
    const p = rowProblem(r, rows, reserved);
    return p ? messages[p] : null;
  };
  const invalid = rows.some((r) => problem(r) !== null);

  const importEnv = async () => {
    const text = await prompt({ title: t('siteEnv.importTitle') || 'Import a .env', message: t('siteEnv.importHint') || 'Paste KEY=VALUE lines: existing names are replaced, the others added.', multiline: true, plain: true });
    if (!text) return;
    const parsed = parseDotEnv(text);
    if (!parsed.length) { toast.error(t('siteEnv.importEmpty') || 'No KEY=VALUE line found'); return; }
    setRows(importRows(rows, parsed, guessSecret));
    toast.success(t('siteEnv.imported', { count: parsed.length, defaultValue: '{{count}} variable(s) imported: review, then save' }));
  };

  const save = async (): Promise<boolean> => {
    setSaving(true);
    try {
      const stored = await onSave(saveBody(rows));
      if (stored === null) return false;
      setRowsState(toRows(stored));
      setDirty(false);
      return true;
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card
        icon={<KeyRound size={14} className="text-accent" />}
        title={title ?? (t('siteEnv.title') || 'Environment variables')}
        actions={(
          <>
            {extraActions?.(api)}
            <Button size="sm" variant="secondary" onClick={() => void importEnv()}><FileUp className="mr-1 h-3.5 w-3.5" />{t('siteEnv.import') || 'Import a .env'}</Button>
            <Button size="sm" variant="secondary" onClick={() => setRows([...rows, emptyRow()])}>
              <Plus className="mr-1 h-3.5 w-3.5" />{t('siteEnv.add') || 'Add'}
            </Button>
            <Button size="sm" disabled={!dirty || invalid} loading={saving} onClick={() => void save()}><Save className="mr-1 h-3.5 w-3.5" />{t('common.save') || 'Save'}</Button>
            {saveExtra?.(save, { dirty, invalid, saving })}
          </>
        )}
      >
        <p className="text-xs text-text-muted">{intro}</p>
        {renderNotice?.(rows.map((r) => r.name), api)}
        {rows.length === 0 ? (
          <p className="mt-4 text-sm text-text-muted">{emptyText ?? (t('siteEnv.empty') || 'No variable yet.')}</p>
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
                      placeholder={r.stored ? (r.secret ? (t('siteEnv.keepSecret') || '•••••• (unchanged)') : (t('siteEnv.newValue') || 'new value')) : (t('siteEnv.value') || 'value')}
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
                      onClick={() => setRows(rows.filter((x) => x.key !== r.key))} />
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
