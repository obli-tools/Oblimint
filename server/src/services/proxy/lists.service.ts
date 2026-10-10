import type { Request } from 'express';
import type { Knex } from 'knex';
import type {
  AccessList, AccessListInput, AccessListRule, AccessListUpdate, AccessListUserInput, CustomPage, CustomPageInput, CustomPagePreviewRequest,
  CustomPageUpdate,
} from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { normalizeCidr } from '../firewall/addresses';
import { assertNeedSomewhere, assertStaff, loadAccount, type HostingActor } from '../hosting/access';
import { isUniqueViolation } from '../hosting/hostingValidation.service';
import { loadOwned, scopeOwned } from '../hosting/p4bAccess';
import { assertListUsersAllowed, auditProxy, emitProxy, lockAccount } from './common';
import { proxyDeps } from './deps';
import { ACCESS_PASSWORD_MAX, ACCESS_PASSWORD_MIN, hashAccessPassword } from './htpasswd';
import type { ProxyListQuery } from './hosts.service';
import { CUSTOM_PAGE_MAX_BYTES, isCustomPageCode, renderPagePlaceholders } from './render/pages';
import { isoNow, numberArray, toRules, toUsers, type AccessListDbRow, type CustomPageDbRow } from './rows';
import { ACCESS_USERNAME_RE, uniq } from './validation';

// ─────────────────────────────────────────────────────────────────────────────
// Access lists and custom pages (docs/P4b-PLAN.md §6.3, §8.8, PX4).
// Access lists: IP rules (normalized CIDR, never 'all') + basic-auth users
// (SHA512-CRYPT hash only, never returned; a rename keeps the hash).
// Custom pages: account pages (proxy.manage) or platform pages (account null,
// staff); a client USES a platform page of its tenant (assertUsable) and sees
// it in the list read-only; ≤ 256 KiB, codes ⊂ CUSTOM_PAGE_CODES.
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_ACCESS_RULES = 200;
export const MAX_ACCESS_USERS = 100;
export const PAGE_APP_NAME = 'Oblimint';

function nameTaken(): AppError {
  return new AppError(409, 'This name is already used in the account', 'nameTaken');
}

// ── access lists ─────────────────────────────────────────────────────────────

async function accessListUsage(ids: number[], conn: Knex | Knex.Transaction = db): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!ids.length) return out;
  const hosts = await conn('proxy_host_access_lists').whereIn('access_list_id', ids).groupBy('access_list_id')
    .select('access_list_id', db.raw('COUNT(*) AS n')) as Array<{ access_list_id: number; n: unknown }>;
  for (const h of hosts) out.set(Number(h.access_list_id), Number(h.n));
  const routes = await conn('proxy_routes').where({ access_list_mode: 'override' }).select('access_list_ids') as Array<{ access_list_ids: unknown }>;
  for (const r of routes) for (const id of numberArray(r.access_list_ids)) if (ids.includes(id)) out.set(id, (out.get(id) ?? 0) + 1);
  return out;
}

async function mapAccessLists(rows: AccessListDbRow[]): Promise<AccessList[]> {
  const usage = await accessListUsage(rows.map((r) => Number(r.id)));
  return rows.map((r) => ({
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    accountId: Number(r.account_id),
    name: r.name,
    satisfyAny: !!r.satisfy_any,
    passAuth: !!r.pass_auth,
    rules: toRules(r.rules),
    users: toUsers(r.users).map((u) => ({ username: u.username })),
    usedBy: usage.get(Number(r.id)) ?? 0,
    createdAt: isoNow(r.created_at),
    updatedAt: isoNow(r.updated_at),
  }));
}

export function normalizeRules(rules: readonly AccessListRule[]): AccessListRule[] {
  if (rules.length > MAX_ACCESS_RULES) throw new AppError(400, `At most ${MAX_ACCESS_RULES} rules`, 'validation');
  const seen = new Set<string>();
  const out: AccessListRule[] = [];
  for (const r of rules) {
    if (r.action !== 'allow' && r.action !== 'deny') throw new AppError(400, 'Invalid rule action', 'validation');
    if (String(r.cidr).trim().toLowerCase() === 'all') throw new AppError(400, "'all' is not a rule: use an empty allow list", 'invalidCidr');
    const cidr = normalizeCidr(r.cidr, { 4: 1, 6: 1 }).cidr;
    const key = `${r.action} ${cidr}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ action: r.action, cidr });
  }
  return out;
}

/** Full user list → stored users (hash kept on rename / no password, new users need one). */
export function normalizeUsers(input: readonly AccessListUserInput[], existing: ReadonlyArray<{ username: string; hash: string }>): Array<{ username: string; hash: string }> {
  if (input.length > MAX_ACCESS_USERS) throw new AppError(400, `At most ${MAX_ACCESS_USERS} users`, 'validation');
  const names = new Set<string>();
  const out: Array<{ username: string; hash: string }> = [];
  for (const u of input) {
    if (!ACCESS_USERNAME_RE.test(u.username)) throw new AppError(400, 'Invalid user name', 'validation', { username: u.username });
    if (names.has(u.username)) throw new AppError(400, `Duplicate user ${u.username}`, 'validation', { username: u.username });
    names.add(u.username);
    let hash: string | undefined;
    if (u.password !== undefined && u.password !== null && u.password !== '') {
      const bytes = Buffer.byteLength(u.password);
      if (u.password.length < ACCESS_PASSWORD_MIN || bytes > ACCESS_PASSWORD_MAX) {
        throw new AppError(400, `The password needs ${ACCESS_PASSWORD_MIN} to ${ACCESS_PASSWORD_MAX} characters`, 'weakPassword', { username: u.username });
      }
      hash = hashAccessPassword(u.password);
    } else {
      hash = existing.find((e) => e.username === (u.previousUsername ?? u.username))?.hash;
      if (!hash) throw new AppError(400, `A password is required for the new user ${u.username}`, 'validation', { username: u.username });
    }
    out.push({ username: u.username, hash });
  }
  return out;
}

export const accessListsService = {
  async list(actor: HostingActor, q: ProxyListQuery): Promise<AccessList[]> {
    if (actor.kind === 'staff') assertNeedSomewhere(actor, 'read');
    const qb = db('access_lists as l').select('l.*');
    scopeOwned(actor, qb, 'l', { filterTenantId: q.tenantId ?? null });
    if (q.accountId) qb.where('l.account_id', q.accountId);
    return mapAccessLists(await qb.orderBy('l.name') as AccessListDbRow[]);
  },

  async get(actor: HostingActor, id: number): Promise<AccessList> {
    const row = await loadOwned(actor, 'access_lists', id, 'read', 'Access list') as unknown as AccessListDbRow;
    return (await mapAccessLists([row]))[0];
  },

  async create(req: Request, actor: HostingActor, body: AccessListInput): Promise<AccessList> {
    const account = await loadAccount(actor, body.accountId, 'proxy.manage');
    const rules = normalizeRules(body.rules ?? []);
    const users = normalizeUsers(body.users ?? [], []);
    let id: number;
    try {
      const [row] = await db('access_lists').insert({
        tenant_id: account.tenant_id, account_id: account.id, name: body.name.trim(), satisfy_any: body.satisfyAny ?? false,
        pass_auth: body.passAuth ?? false, rules: JSON.stringify(rules), users: JSON.stringify(users),
      }).returning('id') as Array<{ id: number }>;
      id = Number(row.id);
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
    await auditProxy(req, account.tenant_id, 'proxy.accessList.create', 'access_list', id, { accountId: account.id, name: body.name, rules: rules.length, users: users.length });
    emitProxy('accessList', id, { tenantId: account.tenant_id, accountId: account.id }, 'created');
    return this.get(actor, id);
  },

  async update(req: Request, actor: HostingActor, id: number, body: AccessListUpdate): Promise<AccessList> {
    const row = await loadOwned(actor, 'access_lists', id, 'proxy.manage', 'Access list') as unknown as AccessListDbRow;
    const patch: Record<string, unknown> = { updated_at: db.fn.now() };
    if (body.name !== undefined) patch.name = body.name.trim();
    if (body.satisfyAny !== undefined) patch.satisfy_any = body.satisfyAny;
    if (body.passAuth !== undefined) patch.pass_auth = body.passAuth;
    if (body.rules !== undefined) patch.rules = JSON.stringify(normalizeRules(body.rules));
    if (body.users !== undefined) patch.users = JSON.stringify(normalizeUsers(body.users, toUsers(row.users)));
    try {
      await db.transaction(async (trx) => {
        // Under the account lock (host saves check the same rule in it): users never land under forward-auth.
        await lockAccount(trx, Number(row.account_id));
        if (body.users !== undefined && toUsers(patch.users).length > 0) await assertListUsersAllowed(trx, id);
        await trx('access_lists').where({ id, tenant_id: row.tenant_id }).update(patch);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
    // Never the passwords nor the hashes in the audit.
    await auditProxy(req, Number(row.tenant_id), 'proxy.accessList.update', 'access_list', id, {
      accountId: row.account_id, fields: Object.keys(body), users: body.users?.map((u) => u.username),
    });
    emitProxy('accessList', id, { tenantId: Number(row.tenant_id), accountId: Number(row.account_id) }, 'updated');
    proxyDeps().scheduleEdgeSync(`access list ${id} updated`);
    return this.get(actor, id);
  },

  async remove(req: Request, actor: HostingActor, id: number, opts: { force: boolean }): Promise<void> {
    const row = await loadOwned(actor, 'access_lists', id, 'proxy.manage', 'Access list');
    let used = 0;
    await db.transaction(async (trx) => {
      // Under the account lock (host saves re-check their lists FOR SHARE in it): a host saved concurrently is
      // counted here, never silently stripped of a list it was just given.
      await lockAccount(trx, Number(row.account_id));
      used = (await accessListUsage([id], trx)).get(id) ?? 0;
      if (used > 0 && !opts.force) throw new AppError(409, 'This access list is used by proxy hosts', 'accessListInUse', { usedBy: used });
      // Routes keep their ids in jsonb: drop this one (the join table cascades).
      const routes = await trx('proxy_routes').where({ access_list_mode: 'override' }).select('id', 'access_list_ids') as Array<{ id: number; access_list_ids: unknown }>;
      for (const r of routes) {
        const ids = numberArray(r.access_list_ids);
        if (ids.includes(id)) await trx('proxy_routes').where({ id: r.id }).update({ access_list_ids: JSON.stringify(ids.filter((x) => x !== id)) });
      }
      await trx('access_lists').where({ id, tenant_id: row.tenant_id }).del();
    });
    await auditProxy(req, Number(row.tenant_id), 'proxy.accessList.delete', 'access_list', id, { accountId: row.account_id, force: opts.force, usedBy: used });
    emitProxy('accessList', id, { tenantId: Number(row.tenant_id), accountId: Number(row.account_id) }, 'deleted');
    if (used) proxyDeps().scheduleEdgeSync(`access list ${id} deleted`);
  },
};

// ── custom pages ─────────────────────────────────────────────────────────────

async function pageUsage(ids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!ids.length) return out;
  const hosts = await db('proxy_hosts').select('options') as Array<{ options: unknown }>;
  const bump = (id: number) => { if (ids.includes(id)) out.set(id, (out.get(id) ?? 0) + 1); };
  for (const h of hosts) {
    const o = (typeof h.options === 'string' ? JSON.parse(h.options) : h.options) as { errorPageId?: unknown; wakingPageId?: unknown } | null;
    if (o?.errorPageId) bump(Number(o.errorPageId));
    if (o?.wakingPageId && o.wakingPageId !== o.errorPageId) bump(Number(o.wakingPageId));
  }
  const dead = await db('proxy_dead_hosts').whereIn('custom_page_id', ids).select('custom_page_id') as Array<{ custom_page_id: number }>;
  for (const d of dead) bump(Number(d.custom_page_id));
  return out;
}

async function mapPages(rows: CustomPageDbRow[]): Promise<CustomPage[]> {
  const usage = await pageUsage(rows.map((r) => Number(r.id)));
  return rows.map((r) => ({
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    accountId: r.account_id === null ? null : Number(r.account_id),
    name: r.name,
    description: r.description,
    codes: numberArray(r.codes).filter(isCustomPageCode),
    html: r.html,
    theme: (['obli', 'light', 'dark', 'custom'].includes(r.theme) ? r.theme : 'obli') as CustomPage['theme'],
    isWakingPage: !!r.is_waking_page,
    usedBy: usage.get(Number(r.id)) ?? 0,
    createdAt: isoNow(r.created_at),
    updatedAt: isoNow(r.updated_at),
  }));
}

function checkPage(html: string | undefined, codes: number[] | undefined): void {
  if (html !== undefined && Buffer.byteLength(html) > CUSTOM_PAGE_MAX_BYTES) throw new AppError(400, 'The page is too large (256 KiB max)', 'validation');
  if (codes !== undefined && codes.some((c) => !isCustomPageCode(c))) throw new AppError(400, 'Invalid error code', 'validation');
}

/** Platform page visible (read-only) to a client: a platform row of its tenant or of the master tenant. */
function clientSeesPlatformPage(actor: HostingActor, row: CustomPageDbRow): boolean {
  return actor.kind === 'client' && row.account_id === null && (Number(row.tenant_id) === actor.tenantId || Number(row.tenant_id) === 1);
}

export const customPagesService = {
  async list(actor: HostingActor, q: ProxyListQuery): Promise<CustomPage[]> {
    if (actor.kind === 'staff') assertNeedSomewhere(actor, 'read');
    const qb = db('custom_pages as p').select('p.*');
    if (actor.kind === 'client') {
      const own = db('custom_pages as p').select('p.*');
      scopeOwned(actor, own, 'p');
      if (q.accountId) own.where('p.account_id', q.accountId);
      const platform = await db('custom_pages').whereNull('account_id').whereIn('tenant_id', [actor.tenantId, 1]) as CustomPageDbRow[];
      const rows = [...(await own.orderBy('p.name') as CustomPageDbRow[]), ...platform];
      return mapPages(rows);
    }
    scopeOwned(actor, qb, 'p', { filterTenantId: q.tenantId ?? null, includePlatform: true });
    if (q.accountId) qb.where((b) => { b.where('p.account_id', q.accountId!).orWhereNull('p.account_id'); });
    return mapPages(await qb.orderBy('p.name') as CustomPageDbRow[]);
  },

  async get(actor: HostingActor, id: number): Promise<CustomPage> {
    const row = await db('custom_pages').where({ id }).first() as CustomPageDbRow | undefined;
    if (row && clientSeesPlatformPage(actor, row)) return (await mapPages([row]))[0];
    const owned = await loadOwned(actor, 'custom_pages', id, 'read', 'Custom page') as unknown as CustomPageDbRow;
    return (await mapPages([owned]))[0];
  },

  async create(req: Request, actor: HostingActor, body: CustomPageInput): Promise<CustomPage> {
    let owner: { tenantId: number; accountId: number | null };
    if (body.accountId === null) {
      assertStaff(actor);
      assertNeedSomewhere(actor, 'proxy.manage');
      owner = { tenantId: actor.tenantId, accountId: null };
    } else {
      const account = await loadAccount(actor, body.accountId, 'proxy.manage');
      owner = { tenantId: account.tenant_id, accountId: account.id };
    }
    const codes = uniq(body.codes ?? []);
    checkPage(body.html, codes);
    const [row] = await db('custom_pages').insert({
      tenant_id: owner.tenantId, account_id: owner.accountId, name: body.name.trim(), description: body.description ?? null,
      codes: JSON.stringify(codes), html: body.html, theme: body.theme ?? 'obli', is_waking_page: body.isWakingPage ?? false,
    }).returning('id') as Array<{ id: number }>;
    const id = Number(row.id);
    await auditProxy(req, owner.tenantId, 'proxy.page.create', 'custom_page', id, { accountId: owner.accountId, name: body.name, codes });
    emitProxy('customPage', id, owner, 'created');
    return this.get(actor, id);
  },

  async update(req: Request, actor: HostingActor, id: number, body: CustomPageUpdate): Promise<CustomPage> {
    const row = await loadOwned(actor, 'custom_pages', id, 'proxy.manage', 'Custom page');
    const codes = body.codes === undefined ? undefined : uniq(body.codes);
    checkPage(body.html, codes);
    const patch: Record<string, unknown> = { updated_at: db.fn.now() };
    if (body.name !== undefined) patch.name = body.name.trim();
    if (body.description !== undefined) patch.description = body.description;
    if (codes !== undefined) patch.codes = JSON.stringify(codes);
    if (body.html !== undefined) patch.html = body.html;
    if (body.theme !== undefined) patch.theme = body.theme;
    if (body.isWakingPage !== undefined) patch.is_waking_page = body.isWakingPage;
    await db('custom_pages').where({ id, tenant_id: row.tenant_id }).update(patch);
    const owner = { tenantId: Number(row.tenant_id), accountId: row.account_id === null ? null : Number(row.account_id) };
    await auditProxy(req, owner.tenantId, 'proxy.page.update', 'custom_page', id, { accountId: owner.accountId, fields: Object.keys(body) });
    emitProxy('customPage', id, owner, 'updated');
    proxyDeps().scheduleEdgeSync(`custom page ${id} updated`);
    return this.get(actor, id);
  },

  async remove(req: Request, actor: HostingActor, id: number): Promise<void> {
    const row = await loadOwned(actor, 'custom_pages', id, 'proxy.manage', 'Custom page');
    const used = (await pageUsage([id])).get(id) ?? 0;
    if (used > 0) throw new AppError(409, 'This page is used by proxy hosts or dead hosts', 'customPageInUse', { usedBy: used });
    await db('custom_pages').where({ id, tenant_id: row.tenant_id }).del();
    const owner = { tenantId: Number(row.tenant_id), accountId: row.account_id === null ? null : Number(row.account_id) };
    await auditProxy(req, owner.tenantId, 'proxy.page.delete', 'custom_page', id, { accountId: owner.accountId });
    emitProxy('customPage', id, owner, 'deleted');
  },

  /** POST /custom-pages/preview: placeholders replaced (escaped values), nothing stored. */
  preview(actor: HostingActor, body: CustomPagePreviewRequest): { html: string } {
    if (actor.kind === 'staff') assertNeedSomewhere(actor, 'read');
    if (Buffer.byteLength(body.html) > CUSTOM_PAGE_MAX_BYTES) throw new AppError(400, 'The page is too large (256 KiB max)', 'validation');
    return {
      html: renderPagePlaceholders(body.html, { code: body.code, appName: PAGE_APP_NAME, proxyHostId: null, host: body.host ?? 'example.com', wakeEtaSec: 15 }),
    };
  },
};
