import type { MigrationFollowUp, MigrationWarning, PlannedMailbox } from '@oblimint/shared';
import { mailEngineHasMailboxes } from '@oblimint/shared';
import type { MigrationStepContext, MigrationStepOutcome } from '../../contracts/execution';
import type { SourceSession } from '../../contracts/source';
import { credentialDigest, errorCode, followUp, isClientError, lower, outcome, runOwner, skipped, splitMailAddress, warning } from './common';
import { mailDnsDeps } from './deps';
import { domainIdOf } from './zone';

// ─────────────────────────────────────────────────────────────────────────────
// Steps mail:domain / mail:dkim / mail:mailbox / mail:alias (docs/P5-PLAN.md
// §9.4, D-MAIL). Every object goes through mailService (limits, locks,
// engine sync, audit of the mail module) with the run's actor; idempotent via
// the object map (kinds mailDomain / dkimKey / mailbox / alias), upsert only.
//
// Secrets (MG2): the source hashes (cwpSecrets.mailboxHashes, one read per
// domain cached on the run's SESSION object — gone with it) and the DKIM PEM
// (cwpSecrets.dkimPrivateKey) only live in local variables between the source
// and their target column (mailboxes.password_hash / mail_dkim_keys sealed).
// They never reach a step result, an event, a warning, an error or a log.
// ─────────────────────────────────────────────────────────────────────────────

/** Mailbox hashes of a domain, per run session (in memory only). */
const hashCache = new WeakMap<SourceSession, Map<string, Map<string, string>>>();

async function sourceHash(ctx: MigrationStepContext, domain: string, address: string): Promise<string | null> {
  const session = await ctx.session();
  let perDomain = hashCache.get(session);
  if (!perDomain) { perDomain = new Map(); hashCache.set(session, perDomain); }
  let hashes = perDomain.get(domain);
  if (!hashes) {
    let rows;
    try {
      rows = await mailDnsDeps().secrets.mailboxHashes(session, domain);
    } catch {
      // Generic on purpose: the reader's errors are generic already, nothing of the output may leak.
      throw new Error(`The mailbox password hashes of ${domain} could not be read on the source`);
    }
    hashes = new Map(rows.filter((r) => typeof r.hash === 'string' && r.hash.trim()).map((r) => [lower(r.address), r.hash.trim()]));
    perDomain.set(domain, hashes);
  }
  return hashes.get(address) ?? null;
}

async function mailEngineCheck(ctx: MigrationStepContext, scope: { kind: 'mailDomain' | 'mailbox' | 'alias' | 'dkim'; key: string }): Promise<MigrationStepOutcome | null> {
  const engine = await mailDnsDeps().mail.engine();
  if (mailEngineHasMailboxes(engine)) return null;
  return skipped({ reason: 'mailEngineExternal', engine }, [warning(ctx, 'mailEngineExternal', 'info', scope, { engine })]);
}

async function mailDomainId(ctx: MigrationStepContext, domain: string): Promise<number | null> {
  return mailDnsDeps().objectMap.resolve(ctx.run.sourceId, 'mailDomain', lower(domain), runOwner(ctx));
}

function requireAccount(ctx: MigrationStepContext): number {
  const id = ctx.targetAccountId();
  if (!id) throw new Error('The target account does not exist yet (account step)');
  return id;
}

// ── mail:domain:<name> ───────────────────────────────────────────────────────

export async function runMailDomainStep(ctx: MigrationStepContext, domainName: string): Promise<MigrationStepOutcome> {
  const deps = mailDnsDeps();
  const name = lower(domainName);
  const scope = { kind: 'mailDomain' as const, key: name };
  const planned = ctx.account.mailDomains.find((m) => lower(m.name) === name);
  if (!planned) return skipped({ domain: name, reason: 'notInPlan' });
  const accountId = requireAccount(ctx);
  const engineSkip = await mailEngineCheck(ctx, scope);
  if (engineSkip) return engineSkip;

  let id = await deps.objectMap.resolve(ctx.run.sourceId, 'mailDomain', name, runOwner(ctx));
  let created = false;
  if (!id) {
    const existing = await deps.mail.findDomain(name);
    if (existing) {
      if (existing.accountId !== accountId) {
        throw Object.assign(new Error(`${name} already has mail on another account`), { statusCode: 409, code: 'mailDomainExists' });
      }
      id = existing.id;
    } else {
      const domainId = await domainIdOf(ctx, planned.domain || name);
      if (!domainId) throw new Error(`The domain ${planned.domain || name} was not created (domains step)`);
      try {
        id = (await deps.mail.createDomain(ctx.req, ctx.actor, { domainId, enabled: true })).id;
        created = true;
      } catch (err) {
        // Created by a concurrent / interrupted attempt: adopt it when it is ours.
        const again = isClientError(err, 'mailDomainExists') ? await deps.mail.findDomain(name) : null;
        if (!again || again.accountId !== accountId) throw err;
        id = again.id;
      }
    }
    await deps.objectMap.put({
      sourceId: ctx.run.sourceId, cwpUsername: ctx.run.cwpUsername, kind: 'mailDomain', sourceKey: name, targetTable: 'mail_domains',
      targetId: id, meta: { name }, runId: ctx.run.id,
    });
  }
  return outcome({ mailDomainId: id, domain: name, created });
}

// ── mail:dkim:<domain> ───────────────────────────────────────────────────────

export async function runDkimStep(ctx: MigrationStepContext, domainName: string): Promise<MigrationStepOutcome> {
  const deps = mailDnsDeps();
  const domain = lower(domainName);
  const scope = { kind: 'dkim' as const, key: domain };
  const keys = ctx.account.dkim.filter((k) => lower(k.domain) === domain);
  if (!keys.length) return skipped({ domain, reason: 'notInPlan' });
  const engineSkip = await mailEngineCheck(ctx, scope);
  if (engineSkip) return engineSkip;
  const mdId = await mailDomainId(ctx, domain);
  if (!mdId) {
    return skipped({ domain, reason: 'mailDomainMissing' }, [warning(ctx, 'mailDomainMissing', 'warning', { kind: 'mailDomain', key: domain }, { domain })]);
  }

  const warnings: MigrationWarning[] = [];
  const imported: string[] = [];
  const notImported: Array<{ selector: string; reason: string }> = [];
  for (const k of keys) {
    const selector = k.selector;
    const keyScope = { kind: 'dkim' as const, key: `${domain}/${selector}` };
    if (!k.import) {
      // The planner already reported dkimWeakKey: the key generated by Oblimint stays.
      notImported.push({ selector, reason: 'notSelected' });
      continue;
    }
    const mapped = await deps.objectMap.resolve(ctx.run.sourceId, 'dkimKey', `${domain}/${selector}`, runOwner(ctx));
    let pem: string | null;
    try {
      pem = await deps.secrets.dkimPrivateKey(await ctx.session(), domain, selector);
    } catch {
      throw new Error(`The DKIM key ${selector} of ${domain} could not be read on the source`);
    }
    if (!pem) {
      notImported.push({ selector, reason: 'missing' });
      warnings.push(warning(ctx, 'dkimMissing', 'warning', keyScope, { domain, selector }));
      continue;
    }
    let res;
    try {
      res = await deps.importDkimKey(mdId, { selector, privateKeyPem: pem });
    } finally {
      pem = null;
    }
    if (res.imported && res.key) {
      imported.push(selector);
      await deps.objectMap.put({
        sourceId: ctx.run.sourceId, cwpUsername: ctx.run.cwpUsername, kind: 'dkimKey', sourceKey: `${domain}/${selector}`,
        targetTable: 'mail_dkim_keys', targetId: res.key.id, meta: { domain, selector, algorithm: res.key.algorithm }, runId: ctx.run.id,
      });
      if (!mapped) {
        await deps.audit(ctx.req, ctx.run.targetTenantId, 'migration.secret_import', { kind: 'dkimKey', domain, selector, accountId: ctx.targetAccountId() });
      }
      await ctx.log('info', 'dkimImported', { domain, selector });
    } else {
      const reason = res.reason ?? 'unsupportedKey';
      notImported.push({ selector, reason });
      warnings.push(warning(ctx, reason === 'weakKey' ? 'dkimWeakKey' : 'dkimNotImported', 'warning', keyScope, { domain, selector, reason }));
      await ctx.log('warn', reason === 'weakKey' ? 'dkimWeakKey' : 'dkimNotImported', { domain, selector, reason });
    }
  }
  return outcome({ mailDomainId: mdId, domain, imported, notImported }, warnings);
}

// ── mail:mailbox:<address> ───────────────────────────────────────────────────

const QUOTA_DIMENSIONS = new Set(['mailboxQuota', 'mailQuota']);

function quotaRefused(err: unknown): boolean {
  if (!isClientError(err, 'planLimit')) return false;
  const d = (err as { details?: { dimension?: unknown } }).details;
  return typeof d?.dimension === 'string' && QUOTA_DIMENSIONS.has(d.dimension);
}

export async function runMailboxStep(ctx: MigrationStepContext, addressKey: string): Promise<MigrationStepOutcome> {
  const deps = mailDnsDeps();
  const address = lower(addressKey);
  const scope = { kind: 'mailbox' as const, key: address };
  const planned: PlannedMailbox | undefined = ctx.account.mailboxes.find((m) => lower(m.address) === address);
  if (!planned) return skipped({ address, reason: 'notInPlan' });
  const accountId = requireAccount(ctx);
  const engineSkip = await mailEngineCheck(ctx, scope);
  if (engineSkip) return engineSkip;
  const { local, domain } = splitMailAddress(address);
  const mdId = await mailDomainId(ctx, planned.domain || domain);
  if (!mdId) {
    return skipped({ address, reason: 'mailDomainMissing' }, [warning(ctx, 'mailDomainMissing', 'warning', { kind: 'mailDomain', key: domain }, { domain })]);
  }

  const warnings: MigrationWarning[] = [];
  const followUps: MigrationFollowUp[] = [];
  const resetFollowUp = () => followUps.push(followUp(ctx, 'mailPasswordReset', scope, 'manual', { address }));
  let hash = await sourceHash(ctx, lower(planned.domain || domain), address);
  if (hash && !deps.mail.normalizeHash(hash)) {
    warnings.push(warning(ctx, 'mailHashUnsupported', 'warning', scope, { address }));
    hash = null;
  }

  let id = await deps.objectMap.resolve(ctx.run.sourceId, 'mailbox', address, runOwner(ctx));
  if (!id) {
    const existing = await deps.mail.findMailbox(address);
    if (existing && existing.accountId !== accountId) {
      throw Object.assign(new Error(`${address} already exists on another account`), { statusCode: 409, code: 'addressTaken' });
    }
    if (existing) {
      // Adopted (a box of this account created beforehand, or a crash between
      // createMailbox and the mapping): mapped like the other adopted objects so
      // it shows in the report; `adopted` tells the maildir step not to mirror
      // deletions into it nor overwrite its Dovecot UID files once used.
      id = existing.id;
      await deps.objectMap.put({
        sourceId: ctx.run.sourceId, cwpUsername: ctx.run.cwpUsername, kind: 'mailbox', sourceKey: address, targetTable: 'mailboxes',
        targetId: id, meta: { address, adopted: true }, runId: ctx.run.id,
      });
      warnings.push(warning(ctx, 'mailboxAdopted', 'info', scope, { address }));
      await ctx.log('info', 'mailboxAdopted', { address });
    }
  }

  let created = false;
  let hashWritten = false;
  /** What the target holds right after the migration wrote it (fingerprint only, MG2). */
  const appliedState = async (boxId: number): Promise<Record<string, unknown>> => {
    const b = await deps.mail.getMailbox(boxId);
    const h = await deps.mail.passwordHash(boxId);
    return { ...(h ? { hashDigest: credentialDigest(h) } : {}), ...(b ? { enabled: b.enabled, quotaMb: b.quotaMb } : {}) };
  };
  if (!id) {
    const body = {
      mailDomainId: mdId, localPart: planned.localPart ? lower(planned.localPart) : local, quotaMb: planned.quotaMb,
      sendEnabled: true, receiveEnabled: true, ...(hash ? { passwordHash: hash } : {}),
    };
    const create = async (b: typeof body): Promise<number> => {
      try {
        return (await deps.mail.createMailbox(ctx.req, ctx.actor, b)).id;
      } catch (err) {
        if (quotaRefused(err) && b.quotaMb !== undefined) {
          warnings.push(warning(ctx, 'mailQuotaOverPlan', 'warning', scope, { address, quotaMb: planned.quotaMb }));
          const { quotaMb: _q, ...rest } = b;
          return create(rest as typeof body);
        }
        if (b.passwordHash && isClientError(err, 'hashSchemeUnsupported', 'invalidPasswordHash')) {
          warnings.push(warning(ctx, 'mailHashUnsupported', 'warning', scope, { address, scheme: planned.hashScheme }));
          await ctx.log('warn', 'mailHashUnsupported', { address });
          const { passwordHash: _h, ...rest } = b;
          return create(rest as typeof body);
        }
        throw err;
      }
    };
    try {
      id = await create(body);
    } catch (err) {
      if (!isClientError(err, 'invalidAddress', 'addressTaken', 'planLimit')) throw err;
      hash = null;
      await ctx.log('warn', 'mailboxNotCreated', { address, code: errorCode(err).code });
      return skipped({ address, reason: errorCode(err).code }, [warning(ctx, 'mailboxNotCreated', 'warning', scope, { address, code: errorCode(err).code })]);
    }
    created = true;
    hashWritten = !!hash && !warnings.some((w) => w.code === 'mailHashUnsupported');
    if (!hashWritten) {
      if (!hash && !warnings.some((w) => w.code === 'mailHashUnsupported')) warnings.push(warning(ctx, 'mailNoHash', 'warning', scope, { address }));
      // A random password was set by the mail module: never shown, never logged — the owner resets it.
      resetFollowUp();
    }
    // The mapping first (a crash right after the creation must not lose the box), then its applied state.
    await deps.objectMap.put({
      sourceId: ctx.run.sourceId, cwpUsername: ctx.run.cwpUsername, kind: 'mailbox', sourceKey: address, targetTable: 'mailboxes',
      targetId: id, meta: { address }, runId: ctx.run.id,
    });
    if (!planned.enabled) await deps.mail.updateMailbox(ctx.req, ctx.actor, id, { enabled: false });
    await deps.objectMap.put({
      sourceId: ctx.run.sourceId, cwpUsername: ctx.run.cwpUsername, kind: 'mailbox', sourceKey: address, targetTable: 'mailboxes',
      targetId: id, meta: { address, ...await appliedState(id) }, runId: ctx.run.id,
    });
  } else {
    // Refresh (re-run / resync / final sync): the password / state may have changed on CWP until the switch.
    // Never once the domain was switched (Oblimint is the authority), and never over a value changed on the
    // target since the migration wrote it (password reset after a leak, box disabled by the staff…).
    const meta = (await deps.objectMap.meta(ctx.run.sourceId, 'mailbox', address)) ?? {};
    const switched = await deps.domainSwitched(ctx.run.planId, lower(planned.domain || domain));
    const changedOnTarget: string[] = [];
    if (hash && !switched) {
      const wanted = deps.mail.normalizeHash(hash);
      const current = await deps.mail.passwordHash(id);
      const lastDigest = typeof meta.hashDigest === 'string' ? meta.hashDigest : null;
      // Untouched = still what the migration wrote. No fingerprint (adopted box): never overwritten.
      const untouched = lastDigest !== null && current !== null && credentialDigest(current) === lastDigest;
      if (wanted && wanted !== current) {
        if (!untouched) changedOnTarget.push('password');
        else {
          try {
            await deps.mail.setPasswordHash(ctx.req, ctx.actor, id, hash);
            hashWritten = true;
          } catch (err) {
            if (!isClientError(err, 'hashSchemeUnsupported', 'invalidPasswordHash')) throw err;
            warnings.push(warning(ctx, 'mailHashUnsupported', 'warning', scope, { address, scheme: planned.hashScheme }));
          }
        }
      }
    }
    const box = switched ? null : await deps.mail.getMailbox(id);
    if (box) {
      const patch: { quotaMb?: number | null; enabled?: boolean } = {};
      const lastEnabled = typeof meta.enabled === 'boolean' ? meta.enabled : null;
      if (box.enabled !== planned.enabled) {
        if (lastEnabled !== null && box.enabled === lastEnabled) patch.enabled = planned.enabled;
        else changedOnTarget.push('enabled');
      }
      const lastQuota = 'quotaMb' in meta ? (meta.quotaMb as number | null) : undefined;
      if (planned.quotaMb !== undefined && box.quotaMb !== planned.quotaMb) {
        if (lastQuota !== undefined && box.quotaMb === lastQuota) patch.quotaMb = planned.quotaMb;
        else changedOnTarget.push('quota');
      }
      if (Object.keys(patch).length) {
        try {
          await deps.mail.updateMailbox(ctx.req, ctx.actor, id, patch);
        } catch (err) {
          if (!quotaRefused(err) || patch.quotaMb === undefined) throw err;
          warnings.push(warning(ctx, 'mailQuotaOverPlan', 'warning', scope, { address, quotaMb: planned.quotaMb }));
          if (patch.enabled !== undefined) await deps.mail.updateMailbox(ctx.req, ctx.actor, id, { enabled: patch.enabled });
        }
      }
    }
    if (switched) warnings.push(warning(ctx, 'mailboxRefreshSwitched', 'info', scope, { address }));
    if (changedOnTarget.length) {
      warnings.push(warning(ctx, 'mailboxChangedOnTarget', 'info', scope, { address, fields: changedOnTarget.join(', ') }));
      await ctx.log('info', 'mailboxChangedOnTarget', { address, fields: changedOnTarget.join(', ') });
    }
    // New baseline = what the target holds now, for the fields that are the migration's (written now, or
    // already equal to the source); a field changed on the target keeps its old baseline (stays protected).
    if (!switched) {
      const after = await appliedState(id);
      const next: Record<string, unknown> = { ...meta, address };
      const wanted = hash ? deps.mail.normalizeHash(hash) : null;
      if (hashWritten || (wanted && wanted === await deps.mail.passwordHash(id))) {
        if (after.hashDigest) next.hashDigest = after.hashDigest;
      }
      if (!changedOnTarget.includes('enabled') && after.enabled !== undefined) next.enabled = after.enabled;
      if (!changedOnTarget.includes('quota') && after.quotaMb !== undefined) next.quotaMb = after.quotaMb;
      await deps.objectMap.put({
        sourceId: ctx.run.sourceId, cwpUsername: ctx.run.cwpUsername, kind: 'mailbox', sourceKey: address, targetTable: 'mailboxes',
        targetId: id, meta: next, runId: ctx.run.id,
      });
    }
  }
  hash = null;
  if (hashWritten) {
    await deps.audit(ctx.req, ctx.run.targetTenantId, 'migration.secret_import', { kind: 'mailboxHash', address, accountId });
  }
  if (!planned.enabled) warnings.push(warning(ctx, 'mailboxInactive', 'info', scope, { address }));
  return outcome({ mailboxId: id, address, created, adopted: !created && warnings.some((w) => w.code === 'mailboxAdopted'), hashImported: hashWritten }, warnings, followUps);
}

// ── mail:alias:<address> ─────────────────────────────────────────────────────

export async function runAliasStep(ctx: MigrationStepContext, addressKey: string): Promise<MigrationStepOutcome> {
  const deps = mailDnsDeps();
  const address = lower(addressKey);
  const scope = { kind: 'alias' as const, key: address };
  const planned = ctx.account.aliases.find((a) => lower(a.address) === address);
  if (!planned) return skipped({ address, reason: 'notInPlan' });
  const accountId = requireAccount(ctx);
  const engineSkip = await mailEngineCheck(ctx, scope);
  if (engineSkip) return engineSkip;
  const { local, domain } = splitMailAddress(address);
  const mdId = await mailDomainId(ctx, planned.domain || domain);
  if (!mdId) {
    return skipped({ address, reason: 'mailDomainMissing' }, [warning(ctx, 'mailDomainMissing', 'warning', { kind: 'mailDomain', key: domain }, { domain })]);
  }
  const targets = [...new Set(planned.targets.map(lower).filter(Boolean))];
  const put = (table: string, targetId: number, meta: Record<string, unknown>) => deps.objectMap.put({
    sourceId: ctx.run.sourceId, cwpUsername: ctx.run.cwpUsername, kind: 'alias', sourceKey: address, targetTable: table, targetId, meta, runId: ctx.run.id,
  });

  // ── catch-all ('@domain'): catch_all of the mail domain (mailboxes exist by now) ──
  if (local === '') {
    const target = targets[0] ?? null;
    if (!target) return skipped({ address, reason: 'noTarget' });
    const warnings: MigrationWarning[] = [];
    if (targets.length > 1) warnings.push(warning(ctx, 'catchAll', 'warning', scope, { address, target, dropped: targets.length - 1 }));
    const md = await deps.mail.findDomain(lower(planned.domain || domain));
    if (md?.catchAll !== target) {
      try {
        await deps.mail.updateDomain(ctx.req, ctx.actor, mdId, { catchAll: target });
      } catch (err) {
        if (!isClientError(err)) throw err;
        await ctx.log('warn', 'catchAll', { address, target, code: errorCode(err).code });
        return skipped({ address, reason: 'catchAllRefused' }, [warning(ctx, 'catchAll', 'warning', scope, { address, target, code: errorCode(err).code })]);
      }
    }
    await put('mail_domains', mdId, { catchAll: true, target });
    return outcome({ mailDomainId: mdId, address, catchAll: target }, warnings);
  }

  // ── an address that is also a mailbox: CWP's alias row = its forwarding ──
  const box = await deps.mail.findMailbox(address);
  if (box && box.accountId === accountId) {
    const others = targets.filter((t) => t !== address);
    if (others.length === 0) return skipped({ address, reason: 'selfAlias' }); // CWP default "box → itself"
    try {
      await deps.mail.setForwarding(ctx.req, ctx.actor, box.id, { targets: others, keepCopy: targets.includes(address) });
    } catch (err) {
      if (!isClientError(err)) throw err;
      return skipped({ address, reason: 'forwardingRefused' }, [warning(ctx, 'aliasNotCreated', 'warning', scope, { address, code: errorCode(err).code })]);
    }
    await put('mailboxes', box.id, { forwarding: true });
    return outcome({ mailboxId: box.id, address, forwarding: others.length });
  }

  // ── plain alias ──
  let id = await deps.objectMap.resolve(ctx.run.sourceId, 'alias', address, runOwner(ctx));
  let created = false;
  try {
    if (!id) {
      const existing = await deps.mail.findAlias(address);
      if (existing && existing.accountId !== accountId) {
        throw Object.assign(new Error(`${address} already exists on another account`), { statusCode: 409, code: 'addressTaken' });
      }
      if (existing) {
        id = existing.id;
      } else {
        id = (await deps.mail.createAlias(ctx.req, ctx.actor, { mailDomainId: mdId, localPart: local, targets, enabled: planned.enabled, comment: 'Migration CWP' })).id;
        created = true;
      }
      await put('mail_aliases', id, { address });
    }
    if (!created) {
      const current = await deps.mail.findAlias(address);
      const same = current && current.enabled === planned.enabled && current.targets.length === targets.length && current.targets.every((t) => targets.includes(t));
      if (!same) await deps.mail.updateAlias(ctx.req, ctx.actor, id, { targets, enabled: planned.enabled });
    }
  } catch (err) {
    if (!isClientError(err, 'invalidTarget', 'invalidAddress', 'forwardingLoop', 'planLimit', 'addressTaken')) throw err;
    await ctx.log('warn', 'aliasNotCreated', { address, code: errorCode(err).code });
    return skipped({ address, reason: errorCode(err).code }, [warning(ctx, 'aliasNotCreated', 'warning', scope, { address, code: errorCode(err).code })]);
  }
  const external = targets.filter((t) => splitMailAddress(t).domain !== domain).length;
  return outcome({ aliasId: id, address, created, targets: targets.length, externalTargets: external });
}
