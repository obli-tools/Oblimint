import apiClient from './client';
import type {
  ApiResponse, CwpInventory, MigrationAccountChoice, MigrationAccountReport, MigrationAccountStatus,
  MigrationCommandLogEntry, MigrationCommandStatus, MigrationCommandTemplateInfo, MigrationCutoverDomain,
  MigrationCutoverSwitch, MigrationCutoverUpdate, MigrationDiscovery, MigrationHostKeyPin, MigrationPlan,
  MigrationPlanChoices, MigrationPlanCreate, MigrationPlanSummary, MigrationReport, MigrationRun, MigrationRunDetail,
  MigrationRunEvent, MigrationRunRequest, MigrationRunStatus, MigrationSource, MigrationSourceInput,
  MigrationSourceTestResult, MigrationSourceUpdate, MigrationTargetCatalog,
} from '@oblimint/shared';

// /api/system/migration — platform admin on the master tenant (docs/P5-PLAN.md §6; contract frozen in
// server/src/routes/migration*.routes.ts). OWNED BY MODULE `ui-migration` (thin typed wrappers of every route,
// posed by the architect: keep the names, add helpers if needed).

const base = '/system/migration';

async function data<T>(p: Promise<{ data: ApiResponse<T> }>): Promise<T> {
  const res = await p;
  return res.data.data as T;
}

export const migrationApi = {
  // ── sources (source-executor) ──
  listSources: () => data<MigrationSource[]>(apiClient.get(`${base}/sources`)),
  getSource: (id: number) => data<MigrationSource>(apiClient.get(`${base}/sources/${id}`)),
  createSource: (body: MigrationSourceInput) => data<MigrationSource>(apiClient.post(`${base}/sources`, body)),
  updateSource: (id: number, body: MigrationSourceUpdate) => data<MigrationSource>(apiClient.put(`${base}/sources/${id}`, body)),
  deleteSource: (id: number) => data<{ deleted: true }>(apiClient.delete(`${base}/sources/${id}`)),
  testSource: (id: number) => data<MigrationSourceTestResult>(apiClient.post(`${base}/sources/${id}/test`)),
  pinHostKey: (id: number, body: MigrationHostKeyPin) => data<MigrationSource>(apiClient.post(`${base}/sources/${id}/host-key`, body)),
  unpinHostKey: (id: number) => data<MigrationSource>(apiClient.delete(`${base}/sources/${id}/host-key`)),
  commands: (id: number, params: { limit?: number; offset?: number; status?: MigrationCommandStatus; runId?: number; discoveryId?: number } = {}) =>
    data<{ items: MigrationCommandLogEntry[]; total: number }>(apiClient.get(`${base}/sources/${id}/commands`, { params })),
  allowlist: () => data<MigrationCommandTemplateInfo[]>(apiClient.get(`${base}/allowlist`)),

  // ── discoveries (discovery) ──
  startDiscovery: (sourceId: number) => data<MigrationDiscovery>(apiClient.post(`${base}/sources/${sourceId}/discoveries`)),
  listDiscoveries: (sourceId: number) => data<MigrationDiscovery[]>(apiClient.get(`${base}/sources/${sourceId}/discoveries`)),
  getDiscovery: (id: number) => data<MigrationDiscovery>(apiClient.get(`${base}/discoveries/${id}`)),
  inventory: (id: number) => data<CwpInventory>(apiClient.get(`${base}/discoveries/${id}/inventory`)),
  cancelDiscovery: (id: number) => data<MigrationDiscovery>(apiClient.post(`${base}/discoveries/${id}/cancel`)),
  deleteDiscovery: (id: number) => data<{ deleted: true }>(apiClient.delete(`${base}/discoveries/${id}`)),

  // ── plans (planner) ──
  targets: () => data<MigrationTargetCatalog>(apiClient.get(`${base}/targets`)),
  listPlans: (params: { sourceId?: number } = {}) => data<MigrationPlanSummary[]>(apiClient.get(`${base}/plans`, { params })),
  createPlan: (body: MigrationPlanCreate) => data<MigrationPlan>(apiClient.post(`${base}/plans`, body)),
  getPlan: (id: number) => data<MigrationPlan>(apiClient.get(`${base}/plans/${id}`)),
  setChoices: (id: number, choices: MigrationPlanChoices) => data<MigrationPlan>(apiClient.put(`${base}/plans/${id}/choices`, choices)),
  setAccountChoice: (id: number, username: string, choice: MigrationAccountChoice) =>
    data<MigrationPlan>(apiClient.put(`${base}/plans/${id}/accounts/${encodeURIComponent(username)}`, choice)),
  computePlan: (id: number) => data<MigrationPlan>(apiClient.post(`${base}/plans/${id}/compute`)),
  rebasePlan: (id: number, discoveryId: number) => data<MigrationPlan>(apiClient.post(`${base}/plans/${id}/rebase`, { discoveryId })),
  deletePlan: (id: number) => data<{ deleted: boolean; archived: boolean }>(apiClient.delete(`${base}/plans/${id}`)),

  // ── runs + reports (executor-web-db) ──
  startRuns: (planId: number, body: MigrationRunRequest) => data<MigrationRun[]>(apiClient.post(`${base}/plans/${planId}/runs`, body)),
  accountStatuses: (planId: number) => data<MigrationAccountStatus[]>(apiClient.get(`${base}/plans/${planId}/accounts`)),
  planReport: (planId: number) => data<MigrationReport>(apiClient.get(`${base}/plans/${planId}/report`)),
  /** Markdown text (download through utils/download). */
  planReportMarkdown: async (planId: number): Promise<string> => {
    const res = await apiClient.get<string>(`${base}/plans/${planId}/report.md`, { responseType: 'text' });
    return res.data;
  },
  listRuns: (params: { planId?: number; status?: MigrationRunStatus; account?: string } = {}) =>
    data<MigrationRun[]>(apiClient.get(`${base}/runs`, { params })),
  getRun: (id: number) => data<MigrationRunDetail>(apiClient.get(`${base}/runs/${id}`)),
  runEvents: (id: number, params: { after?: number; limit?: number; stepKey?: string } = {}) =>
    data<MigrationRunEvent[]>(apiClient.get(`${base}/runs/${id}/events`, { params })),
  runReport: (id: number) => data<MigrationAccountReport>(apiClient.get(`${base}/runs/${id}/report`)),
  pauseRun: (id: number) => data<MigrationRun>(apiClient.post(`${base}/runs/${id}/pause`)),
  resumeRun: (id: number) => data<MigrationRun>(apiClient.post(`${base}/runs/${id}/resume`)),
  cancelRun: (id: number) => data<MigrationRun>(apiClient.post(`${base}/runs/${id}/cancel`)),
  retryRun: (id: number) => data<MigrationRun>(apiClient.post(`${base}/runs/${id}/retry`)),

  // ── cutover (executor-mail-dns) ──
  cutover: (planId: number) => data<MigrationCutoverDomain[]>(apiClient.get(`${base}/plans/${planId}/cutover`)),
  refreshCutover: (planId: number) => data<MigrationCutoverDomain[]>(apiClient.post(`${base}/plans/${planId}/cutover/refresh`)),
  updateCutover: (id: number, body: MigrationCutoverUpdate) => data<MigrationCutoverDomain>(apiClient.put(`${base}/cutover/${id}`, body)),
  checkCutover: (id: number) => data<MigrationCutoverDomain>(apiClient.post(`${base}/cutover/${id}/check`)),
  finalSync: (id: number) => data<MigrationRun>(apiClient.post(`${base}/cutover/${id}/final-sync`)),
  switchCutover: (id: number, body: MigrationCutoverSwitch) => data<MigrationCutoverDomain>(apiClient.post(`${base}/cutover/${id}/switch`, body)),
  rollbackCutover: (id: number) => data<MigrationCutoverDomain>(apiClient.post(`${base}/cutover/${id}/rollback`)),
};
