import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { FileDown, FileJson, FileText, RefreshCw } from 'lucide-react';
import type { MigrationReport } from '@oblimint/shared';
import { migrationApi } from '@/api/migration.api';
import { Card, headerBtnCls } from '@/components/hosting/hostingUi';
import { saveJson, saveText } from '@/utils/download';
import { formatDateTime } from '../migrationFormat';
import { FollowUpList, LoadState, TreeNode, loadErrorOf, toastMigrationError, type LoadError } from '../migrationUi';
import { AccountReportView } from '../report/AccountReportView';

/** Plan report (GET /plans/:id/report) + exports Markdown (server-rendered, French) and JSON. */
export function PlanReportTab({ planId }: { planId: number }) {
  const { t, i18n } = useTranslation();
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    try {
      setReport(await migrationApi.planReport(planId));
      setError(null);
    } catch (err) {
      setReport(null);
      setError(loadErrorOf(t, err, t('migration.report.loadFailed') || 'Failed to load the report'));
    } finally {
      setLoading(false);
    }
  }, [planId, t]);
  useEffect(() => { void load(); }, [load]);

  const exportMd = async () => {
    setExporting(true);
    try {
      const md = await migrationApi.planReportMarkdown(planId);
      if (!(await saveText(md, `migration-${planId}.md`, 'text/markdown;charset=utf-8'))) toast.error(t('migration.report.exportFailed') || 'The export failed');
    } catch (err) {
      toastMigrationError(t, err, t('migration.report.exportFailed') || 'The export failed');
    } finally {
      setExporting(false);
    }
  };
  const exportJson = async () => {
    if (!report) return;
    if (!(await saveJson(report, `migration-${planId}.json`))) toast.error(t('migration.report.exportFailed') || 'The export failed');
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-text-muted">{t('migration.report.description') || 'What was migrated per account, what was skipped and why, the warnings and the manual follow-ups.'}</p>
        <button type="button" className={headerBtnCls} onClick={() => { setLoading(true); void load(); }}><RefreshCw size={14} />{t('common.refresh') || 'Refresh'}</button>
        <button type="button" className={headerBtnCls} disabled={exporting} onClick={() => { void exportMd(); }}><FileText size={14} />{t('migration.report.exportMd') || 'Markdown'}</button>
        <button type="button" className={headerBtnCls} disabled={!report} onClick={() => { void exportJson(); }}><FileJson size={14} />JSON</button>
      </div>
      <LoadState loading={loading} error={error} empty={!report || report.accounts.length === 0} emptyIcon={<FileDown />} emptyText={t('migration.report.empty') || 'Nothing migrated yet.'}>
        {report && (
          <>
            <p className="font-mono text-[11px] text-text-muted">{formatDateTime(report.generatedAt, i18n.language)}</p>
            <div className="space-y-1 rounded-xl bg-bg-secondary p-2">
              {report.accounts.map((a) => (
                <TreeNode
                  key={a.cwpUsername}
                  title={<span className="font-mono">{a.cwpUsername}</span>}
                  meta={`${a.migrated.length} · ${a.warnings.length} · ${a.followUps.length}`}
                >
                  <div className="p-1"><AccountReportView report={a} /></div>
                </TreeNode>
              ))}
            </div>
            {report.serverFollowUps.length > 0 && (
              <Card title={t('migration.report.serverFollowUps') || 'Server follow-ups (outside CWP)'}>
                <FollowUpList followUps={report.serverFollowUps} />
              </Card>
            )}
          </>
        )}
      </LoadState>
    </div>
  );
}
