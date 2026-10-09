import type { Request } from 'express';
import type { SiteMailRelay, SiteMailRelayUpdate } from '@oblimint/shared';
import { db } from '../../../db';
import { AppError } from '../../../middleware/errorHandler';
import { logger } from '../../../utils/logger';
import { auditService } from '../../audit.service';
import { loadAccount, loadSite, type HostingActor } from '../../hosting/access';
import { siteRelayUsername } from '../../hosting/naming';
import { iso, planLimits } from '../../hosting/rows';
import { platformSettings } from '../../platformSettings';
import { errText } from '../../setup/docker';
import { emitMail } from '../events';
import type { MailSiteRelayRow } from '../rows';
import { allowedSendersView, isAllowedSender } from './relayConfig';
import {
  activeMailDomains, ensureRelayRows, rotateCredential, siteRelayState, syncAccountRelays, writeRelayFiles,
} from './relaySync';

// ─────────────────────────────────────────────────────────────────────────────
// Site relay of PHP mail() (docs/P4-PLAN.md §6.5, §9.5) — module
// outbound-security. One SASL user per site (site-<id>, random credential:
// SHA512-CRYPT hash for the relay, clear value sealed with
// secretBox('mail-relay') to rewrite the site's msmtprc), NEVER returned by
// the API nor logged (MA4). Reads need 'read' on the site's account, changes
// 'mail.manage' (A1–A6: 404 invisible, 403 without the need).
// ─────────────────────────────────────────────────────────────────────────────

interface SiteBrief {
  id: number;
  name: string;
  account_id: number;
  tenant_id: number;
}

interface Ctx {
  siteRelayOn: boolean;
  accountStatus: string;
  activeDomains: string[];
  sentLastHour: Map<number, number>;
}

function toApi(site: SiteBrief, row: MailSiteRelayRow | null, ctx: Ctx): SiteMailRelay {
  const st = siteRelayState(row ?? { enabled: true, default_sender: null }, ctx);
  return {
    siteId: site.id,
    siteName: site.name,
    accountId: site.account_id,
    enabled: row ? !!row.enabled : true,
    username: row?.username ?? siteRelayUsername(site.id),
    defaultSender: row?.default_sender ?? null,
    allowedSenders: allowedSendersView(st.defaultSender, ctx.activeDomains),
    perHour: row?.per_hour ?? null,
    sentLastHour: ctx.sentLastHour.get(site.id) ?? 0,
    configured: !!row?.config_hash && st.enabled,
    updatedAt: row ? iso(row.updated_at) : null,
  };
}

async function contextOf(accountId: number, accountStatus: string): Promise<Ctx> {
  const [settings, domains, sent] = await Promise.all([
    platformSettings.section('mail'),
    activeMailDomains([accountId]),
    db('mail_log').where({ account_id: accountId, direction: 'relay', event: 'accepted' })
      .andWhere('at', '>', new Date(Date.now() - 3600_000)).whereNotNull('site_id')
      .groupBy('site_id').select('site_id', db.raw('count(*) as n')) as Promise<Array<{ site_id: number; n: string | number }>>,
  ]);
  return {
    siteRelayOn: settings.siteRelay,
    accountStatus,
    activeDomains: domains.get(accountId) ?? [],
    sentLastHour: new Map(sent.map((r) => [Number(r.site_id), Number(r.n)])),
  };
}

async function rowOf(siteId: number): Promise<MailSiteRelayRow | null> {
  return (await db('mail_site_relays').where({ site_id: siteId }).first() as MailSiteRelayRow | undefined) ?? null;
}

async function accountStatus(accountId: number): Promise<string> {
  return ((await db('hosting_accounts').where({ id: accountId }).first('status')) as { status: string } | undefined)?.status ?? 'deleting';
}

async function viewOf(site: SiteBrief): Promise<SiteMailRelay> {
  const ctx = await contextOf(site.account_id, await accountStatus(site.account_id));
  return toApi(site, await rowOf(site.id), ctx);
}

async function assertRelayOn(): Promise<void> {
  if (!(await platformSettings.section('mail')).siteRelay) {
    throw new AppError(409, 'The site relay is disabled on this platform', 'relayDisabled');
  }
}

/** Applies a change right away (msmtprc of the account + relay files); failures are logged, the next pass retries. */
async function applyNow(accountId: number): Promise<void> {
  try {
    await syncAccountRelays(accountId);
    await writeRelayFiles();
  } catch (err) {
    logger.warn({ err: errText(err), accountId }, 'site relay change not applied yet (retried by the next pass)');
  }
}

export const relayService = {
  /** GET /mail/relays?accountId — read. */
  async listForAccount(actor: HostingActor, accountId: number): Promise<SiteMailRelay[]> {
    const account = await loadAccount(actor, accountId, 'read');
    const sites = await db('sites').where({ account_id: account.id }).orderBy('name').select('id', 'name', 'account_id', 'tenant_id') as SiteBrief[];
    const rows = new Map((await db('mail_site_relays').where({ account_id: account.id }) as MailSiteRelayRow[]).map((r) => [Number(r.site_id), r]));
    const ctx = await contextOf(account.id, account.status);
    return sites.map((s) => toApi(s, rows.get(Number(s.id)) ?? null, ctx));
  },

  /** GET /sites/:id/mail-relay — read. */
  async get(actor: HostingActor, siteId: number): Promise<SiteMailRelay> {
    const site = await loadSite(actor, siteId, 'read');
    return viewOf(site);
  },

  /** PUT /sites/:id/mail-relay — mail.manage on the site's account (defaultSender must be an allowed sender; perHour ≤ plan). */
  async update(req: Request, actor: HostingActor, siteId: number, body: SiteMailRelayUpdate): Promise<SiteMailRelay> {
    const site = await loadSite(actor, siteId, 'mail.manage');
    await assertRelayOn();
    const patch: Record<string, unknown> = {};
    if (body.defaultSender !== undefined) {
      const sender = body.defaultSender === null ? null : body.defaultSender.trim().toLowerCase();
      if (sender !== null) {
        const domains = (await activeMailDomains([site.account_id])).get(site.account_id) ?? [];
        if (!isAllowedSender(sender, domains)) {
          throw new AppError(400, 'The sender must be an address of an active mail domain of the account', 'senderNotAllowed', { allowedDomains: domains });
        }
      }
      patch.default_sender = sender;
    }
    if (body.perHour !== undefined) {
      if (body.perHour !== null) {
        const plan = await db('hosting_accounts as a').leftJoin('plans as p', 'p.id', 'a.plan_id').where('a.id', site.account_id).first('p.limits') as { limits: unknown } | undefined;
        const limit = planLimits(plan?.limits).mailSiteOutboundPerHour ?? null;
        if (limit !== null && body.perHour > limit) {
          throw new AppError(409, `The plan allows at most ${limit} messages per hour per site`, 'planLimit', { dimension: 'siteOutboundPerHour', limit });
        }
      }
      patch.per_hour = body.perHour;
    }
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    await ensureRelayRows(site.account_id, site.tenant_id);
    if (Object.keys(patch).length) {
      await db('mail_site_relays').where({ site_id: site.id }).update({ ...patch, config_hash: null, updated_at: db.fn.now() });
    }
    await auditService.logReqAs(req, site.tenant_id, 'mail.relay.update', {
      resourceType: 'site', resourcePath: String(site.id),
      details: { siteName: site.name, ...('enabled' in patch ? { enabled: patch.enabled } : {}), ...('default_sender' in patch ? { defaultSender: patch.default_sender } : {}), ...('per_hour' in patch ? { perHour: patch.per_hour } : {}) },
    });
    await applyNow(site.account_id);
    emitMail({ entity: 'relay', id: site.id, accountId: site.account_id, action: 'updated' }, { tenantId: site.tenant_id, accountId: site.account_id });
    return viewOf(site);
  },

  /** POST /sites/:id/mail-relay/rotate — new credential, msmtprc rewritten (no restart needed). Audited. */
  async rotate(req: Request, actor: HostingActor, siteId: number): Promise<SiteMailRelay> {
    const site = await loadSite(actor, siteId, 'mail.manage');
    await assertRelayOn();
    await ensureRelayRows(site.account_id, site.tenant_id);
    await rotateCredential(site.id);
    await auditService.logReqAs(req, site.tenant_id, 'mail.relay.rotate', { resourceType: 'site', resourcePath: String(site.id), details: { siteName: site.name } });
    await applyNow(site.account_id);
    emitMail({ entity: 'relay', id: site.id, accountId: site.account_id, action: 'updated' }, { tenantId: site.tenant_id, accountId: site.account_id });
    return viewOf(site);
  },
};
