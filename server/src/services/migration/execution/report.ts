import type {
  CwpInventory, MigrationAccountPlan, MigrationAccountReport, MigrationFollowUp, MigrationMessage, MigrationObjectKind,
  MigrationPlanResult, MigrationReport, MigrationRun, MigrationScope, MigrationWarning,
} from '@oblimint/shared';
import { db } from '../../../db';
import { AppError } from '../../../middleware/errorHandler';
import { migrationObjectMap } from '../objectMap';
import { CODES_FR, OUTSIDE_FR, SCOPES_FR, STEP_SKIPPED_FR, SUGGESTIONS_FR } from './reportFr';
import { FROZEN_STEP_KEY, frozenPlan, json, toRun, toStep, type RunRow, type StepRow } from './store';
import { domainsToCreate } from './webDb/helpers';

// ─────────────────────────────────────────────────────────────────────────────
// Reports of a migration (docs/P5-PLAN.md §9.5): per account (runs, objects
// on the target from the object map, skipped items, warnings, manual
// follow-ups) and per plan, + the French Markdown export. Read-only.
// ─────────────────────────────────────────────────────────────────────────────

const KIND_LABEL_FR: Record<MigrationObjectKind, string> = {
  plan: 'Plans', account: 'Comptes', domain: 'Domaines', site: 'Sites', dataPath: 'Chemins de données', runtime: 'Runtimes secondaires',
  dbInstance: 'Instances de bases', database: 'Bases de données', dbUser: 'Utilisateurs de bases', zone: 'Zones DNS',
  dnsRecord: 'Enregistrements DNS', mailDomain: 'Domaines de messagerie', mailbox: 'Boîtes aux lettres', alias: 'Alias / redirections',
  dkimKey: 'Clés DKIM', proxyHost: 'Hôtes proxy', cron: 'Tâches planifiées', certificate: 'Certificats (sites)',
  importedCertificate: 'Certificats (proxys)', ftpCredential: 'Accès fichiers (FTP adopté)', release: 'Publications',
};

const STATUS_FR: Record<string, string> = {
  queued: 'en attente', running: 'en cours', paused: 'en pause', failed: 'échouée', done: 'terminée', cancelled: 'annulée',
};
const KIND_FR: Record<string, string> = { initial: 'initiale', resync: 'resynchronisation', 'final-sync': 'synchronisation finale' };
const CUTOVER_FR: Record<string, string> = {
  pending: 'à préparer', prepared: 'préparée', synced: 'synchronisée', switched: 'basculée', 'rolled-back': 'annulée (retour arrière)',
};

interface PlanRowLite {
  id: number;
  source_id: number;
  discovery_id: number;
  name: string;
  result: unknown;
}

async function planRow(planId: number): Promise<PlanRowLite> {
  const row = await db('migration_plans').where({ id: planId }).first('id', 'source_id', 'discovery_id', 'name', 'result') as PlanRowLite | undefined;
  if (!row) throw new AppError(404, 'Plan not found', 'notFound');
  return row;
}

async function inventoryOf(discoveryId: number): Promise<CwpInventory | null> {
  const row = await db('migration_discoveries').where({ id: discoveryId }).first('inventory') as { inventory: unknown } | undefined;
  return json<CwpInventory | null>(row?.inventory, null);
}

function dedupeBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((i) => { const k = key(i); if (seen.has(k)) return false; seen.add(k); return true; });
}

const warningKey = (w: MigrationWarning) => `${w.code}|${w.scope.kind}|${w.scope.key}|${JSON.stringify(w.params ?? {})}`;
const followKey = (f: MigrationFollowUp) => `${f.code}|${f.scope.kind}|${f.scope.key}`;

function outsideFollowUps(inv: CwpInventory | null, account: string | null): MigrationFollowUp[] {
  if (!inv) return [];
  return inv.outside.filter((o) => o.account === account).map((o) => ({
    code: o.code, params: o.params ?? {}, suggestion: o.suggestion, scope: { kind: 'outside', key: o.key, account: o.account },
  }));
}

/** Plan items that are not migrated (a domain served by nothing that carries no mail / zone…), with the reason. */
function planSkipped(account: MigrationAccountPlan): Array<{ scope: MigrationScope; reason: MigrationMessage }> {
  const out: Array<{ scope: MigrationScope; reason: MigrationMessage }> = [];
  const created = new Set(domainsToCreate(account).map((d) => d.fqdn));
  for (const d of account.domains) {
    if (!created.has(d.fqdn)) out.push({ scope: { kind: 'domain', key: d.fqdn, account: account.cwpUsername }, reason: { code: 'domainNotServed', params: { fqdn: d.fqdn } } });
  }
  if (account.ftp && !account.ftp.adopt) {
    out.push({ scope: { kind: 'ftpUser', key: account.ftp.login, account: account.cwpUsername }, reason: { code: 'ftpNotAdopted', params: { login: account.ftp.login } } });
  }
  return out;
}

/** Report of one CWP account of a plan. `account` = the plan's (or a run's frozen) account plan. */
export async function accountReport(plan: PlanRowLite, cwpUsername: string, account: MigrationAccountPlan | null, inv: CwpInventory | null): Promise<MigrationAccountReport> {
  const runRows = await db('migration_runs').where({ plan_id: plan.id, cwp_username: cwpUsername }).orderBy('id') as RunRow[];
  const runs: MigrationRun[] = runRows.map(toRun);
  if (!account) {
    for (const r of [...runRows].reverse()) {
      const f = await frozenPlan(Number(r.id));
      if (f) { account = f.account; break; }
    }
  }
  const entries = await migrationObjectMap.list(Number(plan.source_id), { cwpUsername });
  const migrated = entries.map((e) => {
    const meta = e.meta ?? {};
    const name = typeof meta.name === 'string' ? meta.name : typeof meta.username === 'string' ? meta.username : e.sourceKey;
    return { kind: e.kind, sourceKey: e.sourceKey, targetId: e.targetId, label: `${KIND_LABEL_FR[e.kind] ?? e.kind} — ${name}` };
  });

  // Latest state of each step key across the runs of the account.
  const steps = runRows.length
    ? (await db('migration_run_steps').whereIn('run_id', runRows.map((r) => r.id)).whereNot('key', FROZEN_STEP_KEY).orderBy('run_id').orderBy('id') as StepRow[]).map(toStep)
    : [];
  const latest = new Map<string, (typeof steps)[number]>();
  for (const s of steps) latest.set(s.key, s);

  const skipped = account ? planSkipped(account) : [];
  for (const s of latest.values()) {
    if (s.status !== 'skipped') continue;
    const reason = typeof s.result?.reason === 'string' ? s.result.reason : 'skipped';
    skipped.push({ scope: { kind: 'account', key: s.key, account: cwpUsername }, reason: { code: `stepSkipped.${reason}`, params: { step: s.key } } });
  }
  const warnings = dedupeBy([...(account?.warnings ?? []), ...steps.flatMap((s) => s.warnings)], warningKey);
  const followUps = dedupeBy([...(account?.followUps ?? []), ...outsideFollowUps(inv, cwpUsername)], followKey);
  const accountEntry = entries.find((e) => e.kind === 'account');
  let targetUsername: string | null = null;
  if (accountEntry) {
    const a = await db('hosting_accounts').where({ id: accountEntry.targetId }).first('username') as { username: string } | undefined;
    targetUsername = a?.username ?? null;
  }
  return {
    cwpUsername,
    targetAccountId: accountEntry?.targetId ?? runs.at(-1)?.targetAccountId ?? null,
    targetUsername: targetUsername ?? account?.targetUsername ?? null,
    tenantId: account?.tenantId ?? runs.at(-1)?.targetTenantId ?? 1,
    generatedAt: new Date().toISOString(),
    runs,
    migrated,
    skipped,
    warnings,
    followUps,
  };
}

export async function runReport(runId: number): Promise<MigrationAccountReport> {
  const run = await db('migration_runs').where({ id: runId }).first() as RunRow | undefined;
  if (!run) throw new AppError(404, 'Run not found', 'notFound');
  const plan = await planRow(Number(run.plan_id));
  const frozen = await frozenPlan(runId);
  return accountReport(plan, run.cwp_username, frozen?.account ?? null, await inventoryOf(Number(plan.discovery_id)));
}

export async function planReport(planId: number): Promise<MigrationReport> {
  const plan = await planRow(planId);
  const result = json<MigrationPlanResult | null>(plan.result, null);
  const inv = await inventoryOf(Number(plan.discovery_id));
  const withRuns = await db('migration_runs').where({ plan_id: planId }).distinct('cwp_username').pluck('cwp_username') as string[];
  const names = new Set<string>([...(result?.accounts ?? []).filter((a) => a.selected).map((a) => a.cwpUsername), ...withRuns]);
  const accounts: MigrationAccountReport[] = [];
  for (const name of [...names].sort()) {
    accounts.push(await accountReport(plan, name, result?.accounts.find((a) => a.cwpUsername === name) ?? null, inv));
  }
  return {
    planId,
    sourceId: Number(plan.source_id),
    generatedAt: new Date().toISOString(),
    accounts,
    serverFollowUps: dedupeBy([...(result?.followUps ?? []).filter((f) => !f.scope.account), ...outsideFollowUps(inv, null)], followKey),
  };
}

// ── Markdown (French) ────────────────────────────────────────────────────────

const md = (s: unknown): string => String(s ?? '').replace(/[\\`*_[\]<>|#]/g, (c) => `\\${c}`).replace(/\r?\n/g, ' ');

/** French text of a code (§8.4 catalogue, step skips, items outside CWP), else null. */
export function codeTextFr(code: string): string | null {
  if (code.startsWith('stepSkipped.')) return STEP_SKIPPED_FR[code.slice('stepSkipped.'.length)] ?? STEP_SKIPPED_FR.skipped ?? null;
  return CODES_FR[code] ?? OUTSIDE_FR[code] ?? null;
}

/** French text of a message, its parameters as details; an unknown code stays visible as the code itself. */
export function messageText(m: MigrationMessage): string {
  const params = Object.entries(m.params ?? {}).filter(([, v]) => v !== null && v !== '').map(([k, v]) => `${k} = ${md(v)}`);
  // A `reason` parameter selects a variant when one exists (same rule as the UI: i18next context).
  const reason = typeof m.params?.reason === 'string' ? m.params.reason : null;
  const text = (reason ? CODES_FR[`${m.code}_${reason}`] : null) ?? codeTextFr(m.code);
  return `${text ? md(text) : `\`${m.code}\``}${params.length ? ` (${params.join(', ')})` : ''}`;
}

const scopeFr = (kind: string): string => md(SCOPES_FR[kind] ?? kind);
const suggestionFr = (s: string): string => md(SUGGESTIONS_FR[s] ?? s);

export async function planReportMarkdown(planId: number): Promise<string> {
  const report = await planReport(planId);
  const plan = await planRow(planId);
  const source = await db('migration_sources').where({ id: plan.source_id }).first('name', 'host') as { name: string; host: string } | undefined;
  const cutovers = await db('migration_cutover_domains').where({ plan_id: planId }).orderBy('fqdn')
    .select('cwp_username', 'fqdn', 'mode', 'state', 'switched_at') as Array<{ cwp_username: string; fqdn: string; mode: string; state: string; switched_at: Date | string | null }>;
  const date = new Date(report.generatedAt);
  const lines: string[] = [];
  lines.push(`# Rapport de migration CWP — ${md(plan.name)}`, '');
  lines.push(`- **Source** : ${md(source?.name ?? `#${plan.source_id}`)}${source?.host ? ` (${md(source.host)})` : ''}`);
  lines.push(`- **Plan** : n° ${planId}`);
  lines.push(`- **Généré le** : ${date.toLocaleString('fr-FR', { timeZone: 'UTC' })} UTC`);
  lines.push(`- **Comptes** : ${report.accounts.length}`, '');

  for (const a of report.accounts) {
    lines.push(`## Compte ${md(a.cwpUsername)}`, '');
    lines.push(`- **Cible** : ${a.targetUsername ? md(a.targetUsername) : 'non créé'}${a.targetAccountId ? ` (compte n° ${a.targetAccountId}, tenant n° ${a.tenantId})` : ''}`);
    const last = a.runs.at(-1);
    if (last) {
      lines.push(`- **Dernière exécution** : n° ${last.id}, ${KIND_FR[last.kind] ?? last.kind}, ${STATUS_FR[last.status] ?? last.status}${last.finishedAt ? ` le ${new Date(last.finishedAt).toLocaleString('fr-FR', { timeZone: 'UTC' })} UTC` : ''}`);
      if (last.error) lines.push(`- **Erreur** : ${md(last.error)}`);
    } else lines.push('- **Exécution** : aucune');
    lines.push('');

    lines.push('### Objets migrés', '');
    if (a.migrated.length === 0) lines.push('Aucun objet migré.');
    else {
      const byKind = new Map<string, typeof a.migrated>();
      for (const m of a.migrated) byKind.set(m.kind, [...(byKind.get(m.kind) ?? []), m]);
      for (const [kind, items] of byKind) {
        lines.push(`- **${KIND_LABEL_FR[kind as MigrationObjectKind] ?? kind}** (${items.length}) : ${items.map((i) => `${md(i.sourceKey)} → n° ${i.targetId}`).join(', ')}`);
      }
    }
    lines.push('');

    if (a.skipped.length) {
      lines.push('### Éléments non migrés', '');
      for (const s of a.skipped) lines.push(`- ${md(s.scope.key)} : ${messageText(s.reason)}`);
      lines.push('');
    }

    lines.push('### Avertissements', '');
    if (a.warnings.length === 0) lines.push('Aucun avertissement.');
    for (const w of a.warnings) {
      const sev = w.severity === 'blocking' ? 'BLOQUANT' : w.severity === 'warning' ? 'attention' : 'info';
      lines.push(`- [${sev}] ${scopeFr(w.scope.kind)} ${md(w.scope.key)} : ${messageText(w)}`);
    }
    lines.push('');

    lines.push('### Suivis manuels', '');
    if (a.followUps.length === 0) lines.push('Aucun suivi manuel.');
    for (const f of a.followUps) lines.push(`- ${scopeFr(f.scope.kind)} ${md(f.scope.key)} : ${messageText(f)} — suggestion : ${suggestionFr(f.suggestion)}`);
    lines.push('');

    const cut = cutovers.filter((c) => c.cwp_username === a.cwpUsername);
    lines.push('### Bascule', '');
    if (cut.length === 0) lines.push('Aucune checklist de bascule.');
    for (const c of cut) {
      const mode = c.mode === 'ns-delegation' ? 'délégation NS' : 'enregistrements chez l\'hébergeur DNS';
      lines.push(`- ${md(c.fqdn)} : ${CUTOVER_FR[c.state] ?? c.state} (${mode})${c.switched_at ? `, basculé le ${new Date(c.switched_at).toLocaleString('fr-FR', { timeZone: 'UTC' })} UTC` : ''}`);
    }
    lines.push('');
  }

  if (report.serverFollowUps.length) {
    lines.push('## Suivis manuels du serveur', '');
    for (const f of report.serverFollowUps) lines.push(`- ${md(f.scope.key)} : ${messageText(f)} — suggestion : ${suggestionFr(f.suggestion)}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
