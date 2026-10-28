import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRightLeft, Check, Eraser, Key, KeyRound, Link2, Pencil, Plus, Trash2 } from 'lucide-react';
import type { DbFamily, DbxDdlRequest, DbxTable, DbxTableInfo } from '@oblimint/shared';
import { CodeEditor } from '@/components/apps/CodeEditor';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { Pill } from '@/components/common/Pill';
import { useConfirm, usePrompt } from '@/components/common/ConfirmDialog';
import { ColumnModal, DdlPreviewModal, ForeignKeyModal, IndexModal } from './DdlDialogs';

type Dialog = { kind: 'column'; column?: DbxTableInfo['columns'][number] } | { kind: 'index' } | { kind: 'fk' } | null;

/** Columns, indexes, foreign keys (out and in) and the CREATE statement of a table; every change goes through a DDL preview. */
export function TableStructureTab({ instanceId, dbId, family, info, tables, onOpenTable, onChanged, onRenamed, onDropped }: {
  instanceId: number;
  dbId: number;
  family: DbFamily;
  info: DbxTableInfo;
  tables: DbxTable[];
  onOpenTable?: (table: string) => void;
  onChanged: () => void;
  onRenamed: (newId: string) => void;
  onDropped: () => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [pending, setPending] = useState<{ request: DbxDdlRequest; title: string; after?: () => void } | null>(null);
  const isTable = info.table.kind === 'table';
  const name = info.table.name;
  const ask = (request: DbxDdlRequest, title: string, after?: () => void) => { setDialog(null); setPending({ request, title, after }); };

  const rename = async () => {
    const v = await prompt({ title: t('dbx.table.rename') || 'Rename', defaultValue: name, required: true, maxLength: 64, plain: true });
    if (!v || v === name) return;
    const newId = info.table.schema && info.table.schema !== 'public' ? `${info.table.schema}.${v}` : v;
    ask({ op: 'renameTable', table: info.table.id, newName: v }, t('dbx.table.rename') || 'Rename', () => onRenamed(newId));
  };
  const typed = async (op: 'dropTable' | 'truncateTable') => {
    const ok = await confirm({
      title: op === 'dropTable' ? (t('dbx.table.dropTitle') || 'Drop the table') : (t('dbx.table.truncateTitle') || 'Empty the table'),
      message: op === 'dropTable'
        ? t('dbx.table.dropConfirm', { name, defaultValue: 'The table {{name}} and all its rows will be deleted. Type its name to confirm.' })
        : t('dbx.table.truncateConfirm', { name, defaultValue: 'Every row of {{name}} will be deleted. Type its name to confirm.' }),
      danger: true, requireText: name,
    });
    if (ok) ask({ op, table: info.table.id, confirm: name }, op === 'dropTable' ? (t('dbx.table.dropTitle') || 'Drop the table') : (t('dbx.table.truncateTitle') || 'Empty the table'), op === 'dropTable' ? onDropped : undefined);
  };

  const th = 'px-3 py-2 text-left text-[11px] font-mono font-medium uppercase tracking-[0.1em] text-text-muted';
  const td = 'border-t border-white/[0.03] px-3 py-1.5 align-top';
  const section = (title: ReactNode, count: number | null, action: ReactNode, body: ReactNode) => (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-text-primary">{title} {count !== null && <span className="font-mono text-xs text-text-muted">{count}</span>}</h3>
        <div className="ml-auto">{action}</div>
      </div>
      {body}
    </section>
  );

  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-auto p-3">
      <div className="flex flex-wrap items-center gap-2">
        {info.table.comment && <span className="text-xs text-text-muted">{info.table.comment}</span>}
        <div className="ml-auto flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => void rename()}><ArrowRightLeft className="mr-1.5 h-3.5 w-3.5" />{t('dbx.table.rename') || 'Rename'}</Button>
          {isTable && <Button size="sm" variant="secondary" onClick={() => void typed('truncateTable')}><Eraser className="mr-1.5 h-3.5 w-3.5" />{t('dbx.table.truncate') || 'Empty'}</Button>}
          <Button size="sm" variant="danger" onClick={() => void typed('dropTable')}><Trash2 className="mr-1.5 h-3.5 w-3.5" />{t('dbx.table.drop') || 'Drop'}</Button>
        </div>
      </div>

      {section(t('dbx.structure.columns') || 'Columns', info.columns.length,
        isTable && <Button size="sm" onClick={() => setDialog({ kind: 'column' })}><Plus className="mr-1 h-3.5 w-3.5" />{t('dbx.column.add') || 'Column'}</Button>,
        <div className="overflow-x-auto rounded-lg bg-bg-primary/40">
          <table className="w-full text-[13px]">
            <thead><tr>
              <th className={th}>{t('dbx.structure.name') || 'Name'}</th><th className={th}>{t('dbx.structure.type') || 'Type'}</th>
              <th className={th}>NULL</th><th className={th}>{t('dbx.structure.default') || 'Default'}</th><th className={th}>{t('dbx.structure.extra') || 'Extra'}</th>
              <th className={th}>{t('dbx.structure.comment') || 'Comment'}</th>{isTable && <th className={th} />}
            </tr></thead>
            <tbody>
              {info.columns.map((c) => (
                <tr key={c.name} className="group">
                  <td className={td}><span className="inline-flex items-center gap-1.5 font-mono text-text-primary">{c.primary && <Key className="h-3 w-3 text-amber-400" />}{c.name}</span></td>
                  <td className={`${td} font-mono text-violet-300`}>{c.type}{c.collation ? <span className="ml-1 text-[10px] text-text-muted">{c.collation}</span> : null}</td>
                  <td className={td}>{c.nullable && <Check className="h-3.5 w-3.5 text-text-muted" />}</td>
                  <td className={`${td} font-mono text-text-secondary`}>{c.default ?? <span className="text-text-muted">—</span>}</td>
                  <td className={`${td} font-mono text-[11px] text-text-muted`}>{[c.autoIncrement && (c.identity ? 'identity' : 'auto_increment'), c.binary && 'binary', c.extra && !/auto_increment/i.test(c.extra) && c.extra].filter(Boolean).join(' · ')}</td>
                  <td className={`${td} text-text-muted`}>{c.comment}</td>
                  {isTable && (
                    <td className={`${td} whitespace-nowrap text-right`}>
                      <span className="inline-flex gap-0.5 opacity-60 group-hover:opacity-100">
                        <IconButton size="xs" label={t('common.edit') || 'Edit'} icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setDialog({ kind: 'column', column: c })} />
                        <IconButton size="xs" variant="danger" label={t('dbx.column.drop') || 'Drop the column'} icon={<Trash2 className="h-3.5 w-3.5" />}
                          onClick={() => ask({ op: 'dropColumn', table: info.table.id, column: c.name }, t('dbx.column.dropTitle', { name: c.name, defaultValue: 'Drop column {{name}}' }))} />
                      </span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>)}

      {isTable && section(t('dbx.structure.indexes') || 'Indexes', info.indexes.length,
        <div className="flex gap-1.5">
          <Button size="sm" variant="secondary" onClick={async () => {
            const v = await prompt({ title: t('dbx.structure.primaryKey') || 'Primary key', message: t('dbx.index.pkHint') || 'Columns separated by commas (empty: no primary key).', defaultValue: info.primaryKey.join(', '), plain: true });
            if (v !== null) ask({ op: 'setPrimaryKey', table: info.table.id, columns: v.split(',').map((x) => x.trim()).filter(Boolean) }, t('dbx.structure.primaryKey') || 'Primary key');
          }}><KeyRound className="mr-1 h-3.5 w-3.5" />{t('dbx.structure.primaryKey') || 'Primary key'}</Button>
          <Button size="sm" onClick={() => setDialog({ kind: 'index' })}><Plus className="mr-1 h-3.5 w-3.5" />{t('dbx.index.add') || 'Index'}</Button>
        </div>,
        info.indexes.length > 0 && (
          <div className="overflow-x-auto rounded-lg bg-bg-primary/40">
            <table className="w-full text-[13px]">
              <thead><tr><th className={th}>{t('dbx.structure.name') || 'Name'}</th><th className={th}>{t('dbx.structure.columns') || 'Columns'}</th><th className={th}>{t('dbx.structure.kind') || 'Kind'}</th><th className={th} /></tr></thead>
              <tbody>
                {info.indexes.map((i) => (
                  <tr key={i.name} title={i.definition ?? undefined} className="group">
                    <td className={`${td} font-mono text-text-primary`}>{i.name}</td>
                    <td className={`${td} font-mono text-text-secondary`}>{i.columns.join(', ')}</td>
                    <td className={td}><Pill tone={i.primary ? 'amber' : i.unique ? 'accent' : 'muted'}>{i.primary ? 'PRIMARY' : i.unique ? 'UNIQUE' : 'INDEX'}</Pill></td>
                    <td className={`${td} text-right`}>
                      <IconButton size="xs" variant="danger" className="opacity-60 group-hover:opacity-100" label={t('dbx.index.drop') || 'Drop the index'} icon={<Trash2 className="h-3.5 w-3.5" />}
                        onClick={() => ask({ op: 'dropIndex', table: info.table.id, name: i.name }, t('dbx.index.dropTitle', { name: i.name, defaultValue: 'Drop index {{name}}' }))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {isTable && section(t('dbx.structure.foreignKeys') || 'Foreign keys', info.foreignKeys.length,
        <Button size="sm" onClick={() => setDialog({ kind: 'fk' })}><Plus className="mr-1 h-3.5 w-3.5" />{t('dbx.fk.add') || 'Foreign key'}</Button>,
        info.foreignKeys.length > 0 && (
          <ul className="space-y-1 text-[13px]">
            {info.foreignKeys.map((f) => (
              <li key={f.name} className="group flex flex-wrap items-center gap-2 rounded-lg bg-bg-primary/40 px-3 py-1.5 font-mono">
                <Link2 className="h-3.5 w-3.5 text-sky-400" />
                <span className="text-text-muted">{f.name}</span>
                <span className="text-text-primary">{f.columns.join(', ')}</span>
                <span className="text-text-muted">→</span>
                <button type="button" onClick={() => onOpenTable?.(f.refTable)} className="text-accent hover:underline">{f.refTable}</button>
                <span className="text-text-secondary">({f.refColumns.join(', ')})</span>
                <span className="text-[11px] text-text-muted">ON DELETE {f.onDelete} · ON UPDATE {f.onUpdate}</span>
                <IconButton size="xs" variant="danger" className="ml-auto opacity-60 group-hover:opacity-100" label={t('dbx.fk.drop') || 'Drop the foreign key'} icon={<Trash2 className="h-3.5 w-3.5" />}
                  onClick={() => ask({ op: 'dropForeignKey', table: info.table.id, name: f.name }, t('dbx.fk.dropTitle', { name: f.name, defaultValue: 'Drop foreign key {{name}}' }))} />
              </li>
            ))}
          </ul>
        ))}

      {(info.incoming?.length ?? 0) > 0 && section(t('dbx.structure.incoming') || 'Referenced by', info.incoming!.length, null,
        <ul className="space-y-1 text-[13px]">
          {info.incoming!.map((f) => (
            <li key={`${f.table}:${f.name}`} className="flex flex-wrap items-center gap-2 rounded-lg bg-bg-primary/40 px-3 py-1.5 font-mono">
              <Link2 className="h-3.5 w-3.5 rotate-180 text-sky-400" />
              <button type="button" onClick={() => onOpenTable?.(f.table)} className="text-accent hover:underline">{f.table}</button>
              <span className="text-text-secondary">({f.columns.join(', ')})</span>
              <span className="text-text-muted">→</span>
              <span className="text-text-primary">{f.refColumns.join(', ')}</span>
              <span className="text-[11px] text-text-muted">{f.name}</span>
            </li>
          ))}
        </ul>)}

      {info.ddl && section(t('dbx.structure.ddl') || 'CREATE statement', null, null, <CodeEditor value={info.ddl} readOnly language="sql" minHeight="120px" maxHeight="420px" />)}

      {dialog?.kind === 'column' && <ColumnModal family={family} info={info} column={dialog.column} onClose={() => setDialog(null)} onRequest={ask} />}
      {dialog?.kind === 'index' && <IndexModal info={info} onClose={() => setDialog(null)} onRequest={ask} />}
      {dialog?.kind === 'fk' && <ForeignKeyModal instanceId={instanceId} dbId={dbId} info={info} tables={tables} onClose={() => setDialog(null)} onRequest={ask} />}
      {pending && (
        <DdlPreviewModal instanceId={instanceId} dbId={dbId} request={pending.request} title={pending.title} onClose={() => setPending(null)}
          onDone={() => { if (pending.after) pending.after(); else onChanged(); }} />
      )}
    </div>
  );
}
