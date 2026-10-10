import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Eye, EyeOff, Wand2 } from 'lucide-react';
import type { AppTemplateField } from '@oblimint/shared';
import { IconButton } from '@/components/common/IconButton';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { inputCls, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { fieldDefault, fieldIssue, fieldValueOut, generateFieldValue } from './appsFormat';

export type FieldValues = Record<string, string | boolean>;

/** Initial form values of a template (defaults, or the stored non-secret values). */
export function initialFieldValues(fields: AppTemplateField[], stored?: Record<string, string | number | boolean> | null): FieldValues {
  const out: FieldValues = {};
  for (const f of fields) {
    const v = stored?.[f.key];
    if (f.secret) out[f.key] = stored ? '' : fieldDefault(f);
    else if (v !== undefined) out[f.key] = typeof v === 'boolean' ? v : String(v);
    else out[f.key] = fieldDefault(f);
  }
  return out;
}

/** API values (typed); `keepSecrets`: an empty secret is sent as '' (= keep). */
export function fieldValuesOut(fields: AppTemplateField[], values: FieldValues): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (v === undefined) continue;
    if (f.type !== 'boolean' && String(v).trim() === '' && !f.secret) continue;
    out[f.key] = fieldValueOut(f, v);
  }
  return out;
}

/** First problem of the form (null = ok); `keepSecrets` makes empty secrets acceptable. */
export function firstFieldProblem(t: TFunction, fields: AppTemplateField[], values: FieldValues, keepSecrets = false): string | null {
  for (const f of fields) {
    const v = values[f.key] ?? '';
    if (keepSecrets && f.secret && String(v).trim() === '') continue;
    const issue = fieldIssue(f, v);
    if (issue) return `${fieldLabel(t, f)} — ${fieldIssueText(t, issue)}`;
  }
  return null;
}

export function fieldLabel(t: TFunction, f: AppTemplateField): string {
  return f.labelKey ? t(f.labelKey, { defaultValue: f.label }) : f.label;
}

function fieldIssueText(t: TFunction, issue: NonNullable<ReturnType<typeof fieldIssue>>): string {
  switch (issue) {
    case 'required': return t('apps.fields.required') || 'required';
    case 'number': return t('apps.fields.number') || 'a number is expected';
    case 'email': return t('apps.fields.email') || 'invalid e-mail address';
    case 'url': return t('apps.fields.url') || 'invalid URL (http:// or https://)';
    case 'domain': return t('apps.fields.domain') || 'invalid domain name';
    default: return t('apps.fields.pattern') || 'invalid format';
  }
}

/** Form generated from the AppTemplateField list of a catalog template. */
export function TemplateFieldsForm({ fields, values, onChange, keepSecrets = false, idPrefix = 'tplf' }: {
  fields: AppTemplateField[];
  values: FieldValues;
  onChange: (next: FieldValues) => void;
  /** Edit of an existing stack: secret fields empty = keep the sealed value. */
  keepSecrets?: boolean;
  idPrefix?: string;
}) {
  const { t } = useTranslation();
  const [shown, setShown] = useState<Set<string>>(new Set());
  const set = (key: string, v: string | boolean) => onChange({ ...values, [key]: v });

  if (fields.length === 0) return <p className="text-sm text-text-muted">{t('apps.fields.none') || 'This template has no setting.'}</p>;

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {fields.map((f) => {
        const id = `${idPrefix}-${f.key}`;
        const v = values[f.key] ?? '';
        const issue = String(v).trim() === '' && (keepSecrets && f.secret) ? null : fieldIssue(f, v);
        const showIssue = issue && issue !== 'required';
        const label = fieldLabel(t, f);
        const help = f.description
          ?? (f.secret ? (keepSecrets ? (t('apps.fields.secretKeep') || 'Stored encrypted. Leave empty to keep the current value.') : f.generate ? (t('apps.fields.secretGenerated') || 'Stored encrypted. Generated when left empty.') : (t('apps.fields.secret') || 'Stored encrypted, never shown again.')) : null);
        if (f.type === 'boolean') {
          return (
            <div key={f.key} className="rounded-lg bg-bg-primary p-3 md:col-span-2">
              <ToggleSwitch checked={v === true} onChange={(c) => set(f.key, c)} label={label} description={help ?? undefined} />
            </div>
          );
        }
        const visible = shown.has(f.key);
        return (
          <div key={f.key} className="min-w-0">
            <label className={labelCls} htmlFor={id}>
              {label}{f.required && !(f.secret && (f.generate || keepSecrets)) && <span className="text-accent"> *</span>}
              <span className="ml-1.5 font-mono text-[10px] text-text-muted">{f.key}</span>
            </label>
            {f.type === 'select' && f.options?.length ? (
              <select id={id} value={String(v)} onChange={(e) => set(f.key, e.target.value)} className={selectCls}>
                {!f.required && <option value="">—</option>}
                {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <div className="flex items-center gap-1">
                <input
                  id={id}
                  type={f.type === 'password' || f.secret ? (visible ? 'text' : 'password') : f.type === 'number' ? 'number' : f.type === 'email' ? 'email' : f.type === 'url' ? 'url' : 'text'}
                  inputMode={f.type === 'number' ? 'decimal' : undefined}
                  value={String(v)}
                  onChange={(e) => set(f.key, e.target.value)}
                  autoComplete={f.secret || f.type === 'password' ? 'new-password' : 'off'}
                  autoCapitalize="off"
                  spellCheck={false}
                  className={cn(inputCls, (f.secret || f.type === 'password') && 'font-mono', showIssue && 'ring-1 ring-status-down')}
                />
                {(f.secret || f.type === 'password') && (
                  <IconButton
                    label={visible ? (t('apps.fields.hide') || 'Hide') : (t('apps.fields.show') || 'Show')}
                    icon={visible ? <EyeOff size={14} /> : <Eye size={14} />}
                    size="md"
                    variant="ghost"
                    onClick={() => setShown((s) => { const n = new Set(s); if (n.has(f.key)) n.delete(f.key); else n.add(f.key); return n; })}
                  />
                )}
                {f.generate && (
                  <IconButton
                    label={t('apps.fields.generate') || 'Generate'}
                    icon={<Wand2 size={14} />}
                    size="md"
                    variant="ghost"
                    onClick={() => set(f.key, generateFieldValue(f.generate!))}
                  />
                )}
              </div>
            )}
            {showIssue ? <p className="mt-1 text-xs text-status-down">{fieldIssueText(t, issue!)}</p> : help ? <p className="mt-1 text-xs text-text-muted">{help}</p> : null}
          </div>
        );
      })}
    </div>
  );
}
