import type { Request } from 'express';
import type { AppTemplate, AppTemplateCategory, AppTemplateDetail, AppTemplateField, AppTemplateInput } from '@oblimint/shared';
import { APP_TEMPLATE_CATEGORIES } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import { actorHasNeedSomewhere, type HostingActor } from '../hosting/access';
import { json } from '../hosting/rows';
import { platformSettings } from '../platformSettings';
import { BUILTIN_TEMPLATES } from './catalog/templates';
import { renderFieldValues, unsafePattern } from './catalog/render';
import { validateCompose } from './compose/validate';
import { combinePolicy } from './policy.service';

// App catalog (docs/P4b-PLAN.md §5.4). OWNED BY MODULE `apps-core`.
// Built-in templates live in services/apps/catalog/templates/ (WordPress, Nextcloud, Gitea, Vaultwarden,
// Uptime Kuma, Grafana, n8n, Redis + Obli apps) and are upserted by seedBuiltins() at start.

export const TEMPLATE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface TemplateRow {
  id: number;
  tenant_id: number | null;
  slug: string;
  name: string;
  icon: string;
  category: AppTemplateCategory;
  description: string;
  docs_url: string | null;
  version: string;
  builtin: boolean;
  enabled: boolean;
  compose_yaml: string;
  fields: unknown;
  default_proxy: unknown;
  min_memory_mb: number | null;
}

export function toTemplate(r: TemplateRow): AppTemplate {
  return {
    id: r.id, slug: r.slug, name: r.name, icon: r.icon, category: r.category, description: r.description, docsUrl: r.docs_url,
    version: r.version, builtin: r.builtin, tenantId: r.tenant_id, enabled: r.enabled, fields: json<AppTemplateField[]>(r.fields, []),
    defaultProxy: json<AppTemplate['defaultProxy']>(r.default_proxy, null), minMemoryMb: r.min_memory_mb,
  };
}

function toDetail(r: TemplateRow): AppTemplateDetail {
  return { ...toTemplate(r), composeYaml: r.compose_yaml };
}

const isPlatformAdmin = (actor: HostingActor) => actor.kind === 'staff' && actor.caps === '*' && actor.globalView;

let seeded: Promise<void> | null = null;

/** Seeds the builtins once per process before the first catalog read. */
function ensureSeeded(): Promise<void> {
  if (!seeded) seeded = catalogService.seedBuiltins();
  return seeded;
}

/** Validates the compose of a template with placeholder values (syntax + platform policy, no plan). */
async function assertTemplateCompose(composeYaml: string, fields: AppTemplateField[]): Promise<void> {
  const settings = await platformSettings.section('apps');
  const placeholders = new Map<string, string>();
  for (const f of fields) {
    const v = f.default !== null && f.default !== undefined && String(f.default) !== '' ? String(f.default)
      : f.type === 'url' ? 'https://example.com' : f.type === 'domain' ? 'example.com' : f.type === 'email' ? 'a@example.com'
        : f.type === 'number' ? '1' : f.type === 'boolean' ? 'false' : f.options?.[0] ?? 'placeholder-value';
    placeholders.set(f.key, v);
  }
  const policy = combinePolicy(settings, { tenantId: 0, allowedRegistries: null, deniedImages: [], allowBuild: false, allowConsole: false, allowExternalProxyTargets: false, updatedAt: null });
  const out = validateCompose(composeYaml, {
    env: placeholders, baseDir: 'src', rootDir: 'src', inspector: null,
    policy: { allowedRegistries: policy.allowedRegistries, deniedImages: policy.deniedImages, allowBuild: false, capAddAllowed: policy.capAddAllowed },
    maxServices: settings.maxServicesPerStack, defaults: { memoryMb: settings.defaultServiceMemoryMb, cpus: settings.defaultServiceCpus },
    plan: { cpus: null, memoryMb: null, containers: null, pidsPerContainer: 4096 }, node: { memoryMb: 0, cpus: 0 }, others: { cpus: 0, memoryMb: 0, containers: 0 },
  });
  const errors = out.result.issues.filter((i) => i.severity === 'error');
  if (errors.length) throw new AppError(400, 'The template compose is not valid', 'composeInvalid', { issues: out.result.issues });
}

function checkInput(input: Partial<AppTemplateInput>): void {
  if (input.slug !== undefined && !TEMPLATE_SLUG_RE.test(input.slug)) throw new AppError(400, 'Invalid slug', 'validation');
  if (input.category !== undefined && !(APP_TEMPLATE_CATEGORIES as readonly string[]).includes(input.category)) throw new AppError(400, 'Invalid category', 'validation');
  if (input.fields) {
    const keys = new Set<string>();
    for (const f of input.fields) {
      if (keys.has(f.key)) throw new AppError(400, `Duplicate field ${f.key}`, 'validation');
      keys.add(f.key);
      // ReDoS (security audit P4b): only linear-time patterns run on client values.
      const bad = f.pattern ? unsafePattern(f.pattern) : null;
      if (bad) throw new AppError(400, `Field ${f.key}: pattern refused (${bad})`, 'validation', { field: f.key });
    }
    // Field definitions must be renderable (types, patterns): a dry run with generated values.
    renderFieldValues(input.fields.map((f) => ({ ...f, required: false })), {});
  }
}

async function loadTemplateRow(id: number): Promise<TemplateRow> {
  if (!Number.isInteger(id) || id <= 0) throw new AppError(404, 'Template not found', 'templateNotFound');
  const row = await db('app_templates').where({ id }).first() as TemplateRow | undefined;
  if (!row) throw new AppError(404, 'Template not found', 'templateNotFound');
  return row;
}

/** Who may change a template: platform admin for platform ones, tenant staff with apps.manage for tenant ones. */
function assertTemplateWriter(actor: HostingActor, row: { tenant_id: number | null }): void {
  if (actor.kind !== 'staff') throw new AppError(403, 'Insufficient permissions');
  if (row.tenant_id === null) {
    if (!isPlatformAdmin(actor)) throw new AppError(403, 'Only a platform administrator manages platform templates');
    return;
  }
  if (!actor.globalView && actor.tenantId !== row.tenant_id) throw new AppError(404, 'Template not found', 'templateNotFound');
  if (!actorHasNeedSomewhere(actor, 'apps.manage')) throw new AppError(403, 'Insufficient permissions');
}

export const catalogService = {
  /** Platform templates + the actor's tenant templates (enabled ones for a client). */
  async list(actor: HostingActor, q: { category?: AppTemplateCategory | null; search?: string | null }): Promise<AppTemplate[]> {
    await ensureSeeded();
    const qb = db('app_templates').orderBy([{ column: 'builtin', order: 'desc' }, { column: 'name', order: 'asc' }]);
    if (actor.kind === 'staff' && actor.globalView) { /* every template */ } else qb.where((w) => { w.whereNull('tenant_id').orWhere('tenant_id', actor.tenantId); });
    if (actor.kind === 'client') qb.where({ enabled: true });
    if (q.category) qb.where({ category: q.category });
    if (q.search) {
      const s = `%${q.search.replace(/[%_\\]/g, '\\$&')}%`;
      qb.where((w) => { w.whereILike('name', s).orWhereILike('slug', s).orWhereILike('description', s); });
    }
    return (await qb as TemplateRow[]).map(toTemplate);
  },

  async get(actor: HostingActor, slug: string): Promise<AppTemplateDetail> {
    await ensureSeeded();
    if (!TEMPLATE_SLUG_RE.test(slug)) throw new AppError(404, 'Template not found', 'templateNotFound');
    const rows = await db('app_templates').where({ slug }).where((w) => { w.whereNull('tenant_id').orWhere('tenant_id', actor.tenantId); }) as TemplateRow[];
    const row = rows.find((r) => r.tenant_id !== null) ?? rows.find((r) => r.tenant_id === null);
    if (!row || (actor.kind === 'client' && !row.enabled)) throw new AppError(404, 'Template not found', 'templateNotFound');
    return toDetail(row);
  },

  /** Template used to create a stack of `tenantId` (tenant one first, then platform). */
  async forTenant(tenantId: number, slug: string): Promise<TemplateRow | null> {
    await ensureSeeded();
    const rows = await db('app_templates').where({ slug }).where((w) => { w.whereNull('tenant_id').orWhere('tenant_id', tenantId); }) as TemplateRow[];
    return rows.find((r) => r.tenant_id !== null) ?? rows.find((r) => r.tenant_id === null) ?? null;
  },

  /** Platform admin (platform template) or tenant staff with apps.manage (tenant template). Builtins are read-only. */
  async create(req: Request, actor: HostingActor, input: AppTemplateInput): Promise<AppTemplateDetail> {
    if (actor.kind !== 'staff') throw new AppError(403, 'Insufficient permissions');
    const tenantId = isPlatformAdmin(actor) ? (input.tenantId === undefined ? null : input.tenantId) : actor.tenantId;
    assertTemplateWriter(actor, { tenant_id: tenantId });
    checkInput(input);
    await assertTemplateCompose(input.composeYaml, input.fields);
    const clash = await db('app_templates').where({ slug: input.slug }).where((w) => { if (tenantId === null) w.whereNull('tenant_id'); else w.where('tenant_id', tenantId); }).first('id');
    if (clash) throw new AppError(409, 'A template with this slug already exists', 'templateSlugTaken');
    const [row] = await db('app_templates').insert({
      tenant_id: tenantId, slug: input.slug, name: input.name.slice(0, 128), icon: (input.icon ?? 'box').slice(0, 255), category: input.category,
      description: input.description ?? '', docs_url: input.docsUrl ?? null, version: input.version.slice(0, 32), builtin: false,
      enabled: input.enabled ?? true, compose_yaml: input.composeYaml, fields: JSON.stringify(input.fields),
      default_proxy: input.defaultProxy ? JSON.stringify(input.defaultProxy) : null, min_memory_mb: input.minMemoryMb ?? null,
    }).returning('*') as TemplateRow[];
    await auditService.logReqAs(req, tenantId ?? 1, 'apps.template.create', { resourceType: 'app_template', resourcePath: String(row.id), details: { slug: row.slug, tenantId } });
    return toDetail(row);
  },

  async update(req: Request, actor: HostingActor, id: number, input: Partial<AppTemplateInput>): Promise<AppTemplateDetail> {
    const row = await loadTemplateRow(id);
    if (actor.kind !== 'staff' || (row.tenant_id !== null && !actor.globalView && actor.tenantId !== row.tenant_id)) throw new AppError(404, 'Template not found', 'templateNotFound');
    if (row.builtin) {
      // Built-ins are read-only except their availability, which only a platform admin switches
      // (the Obli templates ship disabled until their images are checked).
      const changed = (Object.keys(input) as Array<keyof AppTemplateInput>).filter((k) => input[k] !== undefined && k !== 'enabled');
      if (changed.length || typeof input.enabled !== 'boolean') throw new AppError(409, 'Built-in templates are read-only (only "enabled" can be changed)', 'templateBuiltin');
      if (!isPlatformAdmin(actor)) throw new AppError(403, 'Only a platform administrator manages platform templates');
      const [updated] = await db('app_templates').where({ id }).update({ enabled: input.enabled, updated_at: db.fn.now() }).returning('*') as TemplateRow[];
      await auditService.logReqAs(req, 1, 'apps.template.update', { resourceType: 'app_template', resourcePath: String(id), details: { slug: updated.slug, enabled: input.enabled } });
      return toDetail(updated);
    }
    assertTemplateWriter(actor, row);
    checkInput(input);
    const fields = input.fields ?? json<AppTemplateField[]>(row.fields, []);
    if (input.composeYaml !== undefined || input.fields !== undefined) await assertTemplateCompose(input.composeYaml ?? row.compose_yaml, fields);
    if (input.slug !== undefined && input.slug !== row.slug) {
      const clash = await db('app_templates').where({ slug: input.slug }).whereNot({ id }).where((w) => { if (row.tenant_id === null) w.whereNull('tenant_id'); else w.where('tenant_id', row.tenant_id); }).first('id');
      if (clash) throw new AppError(409, 'A template with this slug already exists', 'templateSlugTaken');
    }
    const patch: Record<string, unknown> = { updated_at: db.fn.now() };
    if (input.slug !== undefined) patch.slug = input.slug;
    if (input.name !== undefined) patch.name = input.name.slice(0, 128);
    if (input.icon !== undefined) patch.icon = input.icon.slice(0, 255);
    if (input.category !== undefined) patch.category = input.category;
    if (input.description !== undefined) patch.description = input.description;
    if (input.docsUrl !== undefined) patch.docs_url = input.docsUrl;
    if (input.version !== undefined) patch.version = input.version.slice(0, 32);
    if (input.composeYaml !== undefined) patch.compose_yaml = input.composeYaml;
    if (input.fields !== undefined) patch.fields = JSON.stringify(input.fields);
    if (input.defaultProxy !== undefined) patch.default_proxy = input.defaultProxy ? JSON.stringify(input.defaultProxy) : null;
    if (input.minMemoryMb !== undefined) patch.min_memory_mb = input.minMemoryMb;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    const [updated] = await db('app_templates').where({ id }).update(patch).returning('*') as TemplateRow[];
    await auditService.logReqAs(req, row.tenant_id ?? 1, 'apps.template.update', { resourceType: 'app_template', resourcePath: String(id), details: { slug: updated.slug } });
    return toDetail(updated);
  },

  async remove(req: Request, actor: HostingActor, id: number): Promise<{ deleted: true }> {
    const row = await loadTemplateRow(id);
    if (actor.kind !== 'staff' || (row.tenant_id !== null && !actor.globalView && actor.tenantId !== row.tenant_id)) throw new AppError(404, 'Template not found', 'templateNotFound');
    if (row.builtin) throw new AppError(409, 'Built-in templates are read-only', 'templateBuiltin');
    assertTemplateWriter(actor, row);
    await db('app_templates').where({ id }).delete();
    await auditService.logReqAs(req, row.tenant_id ?? 1, 'apps.template.delete', { resourceType: 'app_template', resourcePath: String(id), details: { slug: row.slug } });
    return { deleted: true };
  },

  /** Upsert of the built-in templates (by slug + version). Never throws. */
  async seedBuiltins(): Promise<void> {
    try {
      for (const t of BUILTIN_TEMPLATES) {
        const existing = await db('app_templates').whereNull('tenant_id').where({ slug: t.slug }).first('id', 'version', 'builtin', 'enabled') as
          { id: number; version: string; builtin: boolean; enabled: boolean } | undefined;
        const data = {
          name: t.name, icon: t.icon, category: t.category, description: t.description, docs_url: t.docsUrl, version: t.version, builtin: true,
          compose_yaml: t.composeYaml, fields: JSON.stringify(t.fields), default_proxy: t.defaultProxy ? JSON.stringify(t.defaultProxy) : null,
          min_memory_mb: t.minMemoryMb,
        };
        if (!existing) {
          await db('app_templates').insert({ tenant_id: null, slug: t.slug, enabled: t.enabled, ...data });
        } else if (existing.builtin && existing.version !== t.version) {
          // The enabled flag stays the admin's choice (an Obli template enabled by hand stays enabled).
          await db('app_templates').where({ id: existing.id }).update({ ...data, updated_at: db.fn.now() });
        }
      }
    } catch (err) {
      seeded = null;
      logger.warn({ err: (err as Error)?.message }, 'apps: built-in templates not seeded');
    }
  },
};
