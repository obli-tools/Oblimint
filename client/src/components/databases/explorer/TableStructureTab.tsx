import { useTranslation } from 'react-i18next';
import { Check, Key, Link2 } from 'lucide-react';
import type { DbxTableInfo } from '@oblimint/shared';
import { CodeEditor } from '@/components/apps/CodeEditor';

/** Columns, indexes, foreign keys and (MySQL family) the CREATE statement of a table. */
export function TableStructureTab({ info, onOpenTable }: { info: DbxTableInfo; onOpenTable?: (table: string) => void }) {
  const { t } = useTranslation();
  const th = 'px-3 py-2 text-left text-[11px] font-mono font-medium uppercase tracking-[0.1em] text-text-muted';
  const td = 'border-t border-white/[0.03] px-3 py-1.5 align-top';
  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-auto p-3">
      <section>
        <h3 className="mb-2 text-sm font-semibold text-text-primary">{t('dbx.structure.columns') || 'Columns'} <span className="font-mono text-xs text-text-muted">{info.columns.length}</span></h3>
        <div className="overflow-x-auto rounded-lg bg-bg-primary/40">
          <table className="w-full text-[13px]">
            <thead><tr>
              <th className={th}>{t('dbx.structure.name') || 'Name'}</th><th className={th}>{t('dbx.structure.type') || 'Type'}</th>
              <th className={th}>NULL</th><th className={th}>{t('dbx.structure.default') || 'Default'}</th><th className={th}>{t('dbx.structure.extra') || 'Extra'}</th>
              <th className={th}>{t('dbx.structure.comment') || 'Comment'}</th>
            </tr></thead>
            <tbody>
              {info.columns.map((c) => (
                <tr key={c.name}>
                  <td className={td}><span className="inline-flex items-center gap-1.5 font-mono text-text-primary">{c.primary && <Key className="h-3 w-3 text-amber-400" />}{c.name}</span></td>
                  <td className={`${td} font-mono text-violet-300`}>{c.type}</td>
                  <td className={td}>{c.nullable && <Check className="h-3.5 w-3.5 text-text-muted" />}</td>
                  <td className={`${td} font-mono text-text-secondary`}>{c.default ?? <span className="text-text-muted">—</span>}</td>
                  <td className={`${td} font-mono text-[11px] text-text-muted`}>{[c.autoIncrement && 'auto_increment', c.binary && 'binary'].filter(Boolean).join(' · ')}</td>
                  <td className={`${td} text-text-muted`}>{c.comment}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {info.indexes.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-text-primary">{t('dbx.structure.indexes') || 'Indexes'}</h3>
          <div className="overflow-x-auto rounded-lg bg-bg-primary/40">
            <table className="w-full text-[13px]">
              <thead><tr><th className={th}>{t('dbx.structure.name') || 'Name'}</th><th className={th}>{t('dbx.structure.columns') || 'Columns'}</th><th className={th}>{t('dbx.structure.kind') || 'Kind'}</th></tr></thead>
              <tbody>
                {info.indexes.map((i) => (
                  <tr key={i.name} title={i.definition ?? undefined}>
                    <td className={`${td} font-mono text-text-primary`}>{i.name}</td>
                    <td className={`${td} font-mono text-text-secondary`}>{i.columns.join(', ')}</td>
                    <td className={`${td} text-[12px] text-text-muted`}>{i.primary ? 'PRIMARY' : i.unique ? 'UNIQUE' : 'INDEX'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {info.foreignKeys.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-text-primary">{t('dbx.structure.foreignKeys') || 'Foreign keys'}</h3>
          <ul className="space-y-1 text-[13px]">
            {info.foreignKeys.map((f) => (
              <li key={f.name} className="flex flex-wrap items-center gap-2 rounded-lg bg-bg-primary/40 px-3 py-1.5 font-mono">
                <Link2 className="h-3.5 w-3.5 text-sky-400" />
                <span className="text-text-primary">{f.columns.join(', ')}</span>
                <span className="text-text-muted">→</span>
                <button type="button" onClick={() => onOpenTable?.(f.refTable)} className="text-accent hover:underline">{f.refTable}</button>
                <span className="text-text-secondary">({f.refColumns.join(', ')})</span>
                <span className="text-[11px] text-text-muted">ON DELETE {f.onDelete} · ON UPDATE {f.onUpdate}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {info.ddl && (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-text-primary">{t('dbx.structure.ddl') || 'CREATE statement'}</h3>
          <CodeEditor value={info.ddl} readOnly language="sql" minHeight="120px" maxHeight="420px" />
        </section>
      )}
    </div>
  );
}
