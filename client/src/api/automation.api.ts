import apiClient from './client';
import type {
  ApiResponse, AppMaintenanceWindow, AppMaintenanceWindowInput, AppMaintenanceWindowUpdate, AutomationSshKey, AutomationSshKeyCreate,
  CertificateListItem, SftpTarget, SftpTargetInput, SftpTargetTestResult, SftpTargetUpdate, Workflow, WorkflowInput, WorkflowRun,
  WorkflowUpdate,
} from '@oblimint/shared';

// /api/automation (workflows + runs, SSH keys, SFTP targets, maintenance windows) —
// docs/P4b-PLAN.md §6.6 / §11, contract in the header of
// server/src/routes/automation.routes.ts. OWNED BY MODULE `ui-apps`.

export interface AutomationListParams {
  accountId?: number;
  tenantId?: number;
}

export const automationApi = {
  // ── workflows ──
  async listWorkflows(params: AutomationListParams = {}): Promise<Workflow[]> {
    const res = await apiClient.get<ApiResponse<Workflow[]>>('/automation/workflows', { params });
    return res.data.data ?? [];
  },
  async getWorkflow(id: number): Promise<Workflow> {
    const res = await apiClient.get<ApiResponse<Workflow>>(`/automation/workflows/${id}`);
    return res.data.data!;
  },
  async createWorkflow(data: WorkflowInput): Promise<Workflow> {
    const res = await apiClient.post<ApiResponse<Workflow>>('/automation/workflows', data);
    return res.data.data!;
  },
  async updateWorkflow(id: number, data: WorkflowUpdate): Promise<Workflow> {
    const res = await apiClient.put<ApiResponse<Workflow>>(`/automation/workflows/${id}`, data);
    return res.data.data!;
  },
  async deleteWorkflow(id: number): Promise<void> {
    await apiClient.delete(`/automation/workflows/${id}`);
  },
  async runWorkflow(id: number): Promise<WorkflowRun> {
    const res = await apiClient.post<ApiResponse<WorkflowRun>>(`/automation/workflows/${id}/run`);
    return res.data.data!;
  },
  async listRuns(id: number, params: { limit?: number; offset?: number } = {}): Promise<{ items: WorkflowRun[]; total: number }> {
    const res = await apiClient.get<ApiResponse<{ items: WorkflowRun[]; total: number }>>(`/automation/workflows/${id}/runs`, { params });
    return res.data.data ?? { items: [], total: 0 };
  },

  // ── SSH keys (private keys sealed, never returned) ──
  async listSshKeys(params: AutomationListParams = {}): Promise<AutomationSshKey[]> {
    const res = await apiClient.get<ApiResponse<AutomationSshKey[]>>('/automation/ssh-keys', { params });
    return res.data.data ?? [];
  },
  async createSshKey(data: AutomationSshKeyCreate): Promise<AutomationSshKey> {
    const res = await apiClient.post<ApiResponse<AutomationSshKey>>('/automation/ssh-keys', data);
    return res.data.data!;
  },
  async deleteSshKey(id: number): Promise<void> {
    await apiClient.delete(`/automation/ssh-keys/${id}`);
  },

  // ── SFTP targets ──
  async listSftpTargets(params: AutomationListParams = {}): Promise<SftpTarget[]> {
    const res = await apiClient.get<ApiResponse<SftpTarget[]>>('/automation/sftp-targets', { params });
    return res.data.data ?? [];
  },
  async createSftpTarget(data: SftpTargetInput): Promise<SftpTarget> {
    const res = await apiClient.post<ApiResponse<SftpTarget>>('/automation/sftp-targets', data);
    return res.data.data!;
  },
  async updateSftpTarget(id: number, data: SftpTargetUpdate): Promise<SftpTarget> {
    const res = await apiClient.put<ApiResponse<SftpTarget>>(`/automation/sftp-targets/${id}`, data);
    return res.data.data!;
  },
  async deleteSftpTarget(id: number): Promise<void> {
    await apiClient.delete(`/automation/sftp-targets/${id}`);
  },
  async testSftpTarget(id: number): Promise<SftpTargetTestResult> {
    const res = await apiClient.post<ApiResponse<SftpTargetTestResult>>(`/automation/sftp-targets/${id}/test`);
    return res.data.data!;
  },

  // ── maintenance windows of the automatic app updates ──
  async listWindows(params: AutomationListParams = {}): Promise<AppMaintenanceWindow[]> {
    const res = await apiClient.get<ApiResponse<AppMaintenanceWindow[]>>('/automation/maintenance-windows', { params });
    return res.data.data ?? [];
  },
  async createWindow(data: AppMaintenanceWindowInput): Promise<AppMaintenanceWindow> {
    const res = await apiClient.post<ApiResponse<AppMaintenanceWindow>>('/automation/maintenance-windows', data);
    return res.data.data!;
  },
  async updateWindow(id: number, data: AppMaintenanceWindowUpdate): Promise<AppMaintenanceWindow> {
    const res = await apiClient.put<ApiResponse<AppMaintenanceWindow>>(`/automation/maintenance-windows/${id}`, data);
    return res.data.data!;
  },
  async deleteWindow(id: number): Promise<void> {
    await apiClient.delete(`/automation/maintenance-windows/${id}`);
  },

  /**
   * Certificate picker of the export-certificate action: read-only call of
   * GET /api/proxy/certificates (module proxy-hosts; ui-proxy owns the full
   * proxy wrapper, this one only lists for the picker).
   */
  async listCertificates(params: AutomationListParams = {}): Promise<CertificateListItem[]> {
    const res = await apiClient.get<ApiResponse<CertificateListItem[]>>('/proxy/certificates', { params });
    return res.data.data ?? [];
  },
};
