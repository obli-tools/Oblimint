import crypto from 'crypto';
import type { MailPasswordScheme } from '@oblimint/shared';
import type { MailDesiredState } from '../../driver';
import { MailDriverError } from '../../driver';
import type { PrincipalCreate, PrincipalPatchOp, StalwartPrincipal } from './api';
import {
  aliasListName, catchAllListName, LIST_PREFIX, MANAGED_PERMISSIONS, PERM_JMAP_SUBMIT, PERM_LOGIN, PERM_RECEIVE, PERM_SEND,
} from './constants';
import { domainName, invalid, isMailAddress, mailAddress, positiveInt } from './validate';

// ─────────────────────────────────────────────────────────────────────────────
// PURE projection of the desired state onto Stalwart principals, and the diff
// against what the admin API lists (sync.test.ts). Rules (driver.ts header):
//
//  - one `domain` principal per ACTIVE mail domain of the state (MA10 / D1:
//    a domain principal is what makes a domain local to Stalwart, so an
//    unverified or disabled domain must not have one — otherwise mail sent to
//    that domain from ANY tenant would be handled locally instead of relayed).
//    A domain principal that leaves the active set is deleted by the sync once
//    its addresses are released (it holds no data; mailbox data stays on the
//    individuals until purge());
//  - mailboxes of an inactive domain keep their individual (data) but lose
//    every address (like a detach): emails = [], no secret, the managed
//    permissions disabled — they never count as a detach for the guard;
//  - one `individual` per mailbox, name = address (the login), emails = the
//    address + every alias whose ONLY target is that mailbox (sending as an
//    alias, MA3), secrets = the imported hash converted to the form Stalwart
//    verifies + the live webmail app passwords (R-STALWART-APPPW); a hash the
//    engine cannot verify (e.g. an imported $2x$) does NOT abort the sync: the
//    mailbox gets no secret (no login) and the failure is reported under its
//    domain (secretErrors → domainErrors); quota in
//    bytes, disabledPermissions ⊇ {authenticate | email-send +
//    jmap-email-submission-set | email-receive} from the login / send /
//    receive flags; loginEnabled=false also drops the
//    secrets (no login whatever the permission model);
//  - one `list` per other alias (oblimint-alias-<id>) and per catch-all
//    (oblimint-catchall-<domainId>, email "@domain"); lists hold no data and
//    are deleted when they leave the state;
//  - an individual missing from the state is DETACHED, never deleted: emails
//    and secrets cleared, the managed permissions disabled (its data waits for
//    purge()). Detaching more than half of the attached mailboxes (and more
//    than one) is refused without allowMassRemoval (MailDriverError
//    'massRemoval').
//  - fields the panel does not manage (other permissions, roles beyond 'user',
//    member-of…) are left alone.
// Hashes never appear in an error message (MA4).
// ─────────────────────────────────────────────────────────────────────────────

/** Schemes the pinned Stalwart verifies (api.ts H5); mail-core refuses importing the others. */
export const STALWART_PASSWORD_SCHEMES: readonly MailPasswordScheme[] = [
  'SHA512-CRYPT', 'SHA256-CRYPT', 'MD5-CRYPT', 'BLF-CRYPT', 'SSHA512', 'SSHA256', 'SSHA',
];

/**
 * '{SCHEME}hash' (Dovecot syntax, passwords.ts) → the secret Stalwart stores:
 * crypt(3) hashes bare ($6$ / $5$ / $1$ / $2y$ → verified by crypt rules),
 * salted SHA kept with their {SCHEME} prefix. Throws invalidState (without the
 * hash) for anything else.
 */
export function toStalwartSecret(stored: string): string {
  const m = /^\{([A-Z0-9-]+)\}(\S+)$/.exec(String(stored ?? ''));
  const bad = () => new MailDriverError('invalidState', 'stalwart: unsupported or malformed password hash (scheme not verifiable by the engine)');
  if (!m) throw bad();
  const [, scheme, hash] = m;
  switch (scheme as MailPasswordScheme) {
    case 'SHA512-CRYPT':
      if (!/^\$6\$(rounds=\d{4,9}\$)?[./0-9A-Za-z]{1,16}\$[./0-9A-Za-z]{86}$/.test(hash)) throw bad();
      return hash;
    case 'SHA256-CRYPT':
      if (!/^\$5\$(rounds=\d{4,9}\$)?[./0-9A-Za-z]{1,16}\$[./0-9A-Za-z]{43}$/.test(hash)) throw bad();
      return hash;
    case 'MD5-CRYPT':
      if (!/^\$1\$[./0-9A-Za-z]{1,8}\$[./0-9A-Za-z]{22}$/.test(hash)) throw bad();
      return hash;
    case 'BLF-CRYPT':
      // $2x$ (the buggy pre-2011 variant) is not offered by bcrypt verifiers: refused
      // (buildDesiredPrincipals reports it per mailbox, the sync goes on).
      if (!/^\$2[aby]\$\d{2}\$[./0-9A-Za-z]{53}$/.test(hash)) throw bad();
      return hash;
    case 'SSHA512':
    case 'SSHA256':
    case 'SSHA':
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(hash)) throw bad();
      return `{${scheme}}${hash}`;
    default:
      throw bad();
  }
}

export interface DesiredIndividual {
  name: string;
  domain: string;
  description: string;
  emails: string[];
  secrets: string[];
  quota: number;
  disabled: string[];
}

export interface DesiredList {
  name: string;
  domain: string;
  emails: string[];
  members: string[];
  externalMembers: string[];
}

export interface DesiredPrincipals {
  /** ACTIVE domains only (the ones Stalwart treats as local). */
  domains: string[];
  /** Every mail domain of the state (active or not). */
  allDomains: string[];
  individuals: DesiredIndividual[];
  lists: DesiredList[];
  /** domain → message of a password hash the engine cannot verify (never the hash, MA4). */
  secretErrors: Record<string, string>;
}

const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();
const domainOf = (address: string): string => address.slice(address.lastIndexOf('@') + 1);

/** Secrets fingerprint (sync bookkeeping when the API does not return secrets; never a hash itself). */
export function secretsFingerprint(secrets: string[]): string {
  return crypto.createHash('sha256').update(sorted(secrets).join('\n')).digest('hex');
}

export function buildDesiredPrincipals(state: MailDesiredState, now: Date): DesiredPrincipals {
  const allDomains = sorted(state.domains.map((d) => domainName(d.name)));
  const allSet = new Set(allDomains);
  // A name present on two rows is local as soon as one of them is active.
  const domains = sorted(state.domains.filter((d) => d.active).map((d) => domainName(d.name)));
  const activeSet = new Set(domains);
  const secretErrors: Record<string, string> = {};
  const secretOf = (stored: string, domain: string, what: string): string | null => {
    try {
      return toStalwartSecret(stored);
    } catch (err) {
      const msg = err instanceof MailDriverError ? err.message : 'stalwart: unsupported password hash';
      secretErrors[domain] ??= `${what}: ${msg}`;
      return null;
    }
  };

  const mailboxes = new Map<string, MailDesiredState['mailboxes'][number]>();
  for (const mb of state.mailboxes) {
    const addr = mailAddress(mb.address, 'mailbox address');
    if (!allSet.has(domainOf(addr))) throw invalid(`mailbox domain (${addr})`);
    if (mailboxes.has(addr)) throw invalid(`mailbox (duplicate ${addr})`);
    mailboxes.set(addr, mb);
  }
  /** A local mailbox that is served (its domain is active). */
  const served = (addr: string): boolean => mailboxes.has(addr) && activeSet.has(domainOf(addr));

  // Aliases: single local target → extra email of that mailbox; otherwise a list.
  // Aliases of an inactive domain are not served (mail-core drops them already).
  const extraEmails = new Map<string, string[]>();
  const lists: DesiredList[] = [];
  for (const a of state.aliases) {
    const addr = mailAddress(a.address, 'alias address');
    if (mailboxes.has(addr)) throw invalid(`alias (${addr} is also a mailbox)`);
    if (!allSet.has(domainOf(addr))) throw invalid(`alias domain (${addr})`);
    if (!activeSet.has(domainOf(addr))) continue;
    // A mailbox of an inactive domain is never a target (it has no address any more).
    const targets = sorted(a.targets.map((t) => mailAddress(t, 'alias target')))
      .filter((t) => !mailboxes.has(t) || served(t));
    if (targets.length === 0) continue;
    if (targets.length === 1 && mailboxes.has(targets[0])) {
      extraEmails.set(targets[0], [...(extraEmails.get(targets[0]) ?? []), addr]);
      continue;
    }
    lists.push({
      name: aliasListName(positiveInt(a.id, 'alias id')),
      domain: domainOf(addr),
      emails: [addr],
      members: targets.filter((t) => mailboxes.has(t)),
      externalMembers: targets.filter((t) => !mailboxes.has(t)),
    });
  }
  for (const d of state.domains) {
    if (!d.active || !d.catchAll) continue;
    const name = domainName(d.name);
    const target = mailAddress(d.catchAll, 'catch-all target');
    if (mailboxes.has(target) && !served(target)) continue;
    lists.push({
      name: catchAllListName(positiveInt(d.id, 'domain id')),
      domain: name,
      emails: [`@${name}`],
      members: mailboxes.has(target) ? [target] : [],
      externalMembers: mailboxes.has(target) ? [] : [target],
    });
  }

  // App passwords (webmail SSO) still valid at `now`.
  const appSecrets = new Map<string, string[]>();
  for (const ap of state.appPasswords) {
    const addr = mailAddress(ap.address, 'app password address');
    const exp = new Date(ap.expiresAt).getTime();
    if (!Number.isFinite(exp) || exp <= now.getTime()) continue;
    const secret = secretOf(ap.passwordHash, domainOf(addr), `webmail session of ${addr}`);
    if (secret !== null) appSecrets.set(addr, [...(appSecrets.get(addr) ?? []), secret]);
  }

  const individuals: DesiredIndividual[] = [...mailboxes.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([addr, mb]) => {
    const isServed = served(addr);
    const login = mb.loginEnabled && isServed;
    const disabled: string[] = [];
    if (!login) disabled.push(PERM_LOGIN);
    // Sending = SMTP submission (email-send) AND JMAP submission: both go together.
    if (!mb.sendEnabled || !login) disabled.push(PERM_SEND, PERM_JMAP_SUBMIT);
    if (!mb.receiveEnabled || !isServed) disabled.push(PERM_RECEIVE);
    const quotaMb = mb.quotaMb === null ? 0 : positiveInt(mb.quotaMb, 'mailbox quota', 16 * 1024 * 1024);
    let secrets: string[] = [];
    if (login) {
      const main = secretOf(mb.passwordHash, domainOf(addr), `password of ${addr}`);
      // Unverifiable main hash: no secret at all (no login), reported per domain.
      secrets = main === null ? [] : [main, ...(appSecrets.get(addr) ?? [])];
    }
    return {
      name: addr,
      domain: domainOf(addr),
      description: String(mb.displayName ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200), // eslint-disable-line no-control-regex
      // Inactive domain: no address at all (not served, MA10); its data is kept.
      emails: isServed ? sorted([addr, ...(extraEmails.get(addr) ?? [])]) : [],
      secrets,
      quota: quotaMb * 1048576,
      disabled: sorted(disabled),
    };
  });

  return { domains, allDomains, individuals, lists: lists.sort((a, b) => a.name.localeCompare(b.name)), secretErrors };
}

// ── diff ─────────────────────────────────────────────────────────────────────

export interface PrincipalOp {
  kind: 'create' | 'update' | 'delete';
  name: string;
  /** Domain the failure is reported under (MailSyncResult.domainErrors). */
  domain: string;
  create?: PrincipalCreate;
  ops?: PrincipalPatchOp[];
  /** Secrets fingerprint to remember once applied (individuals). */
  secretsFp?: string;
}

export interface PrincipalPlan {
  /** Phase 1: domains to create. */
  domains: PrincipalOp[];
  /** Phase 2: removals (emails / members leaving a principal, detaches, list deletions) — frees addresses first. */
  removals: PrincipalOp[];
  /** Phase 3: creations and additions. */
  additions: PrincipalOp[];
  /** Phase 4: domain principals that left the active set (their addresses are released in phase 2). */
  domainRemovals: PrincipalOp[];
  /** Domains that left the active set but are kept: a principal the panel does not manage still uses them. */
  domainsKept: string[];
  /** Individuals detached by this plan (left the state). */
  detached: string[];
  /** Individuals currently attached (mass-removal guard base). */
  attachedBefore: number;
}

export interface CurrentPrincipals {
  domains: StalwartPrincipal[];
  individuals: StalwartPrincipal[];
  lists: StalwartPrincipal[];
}

/** Engine-side individuals the panel manages: every principal named like an address. */
export const isManagedIndividual = (p: StalwartPrincipal): boolean => isMailAddress(p.name);
export const isManagedList = (p: StalwartPrincipal): boolean => p.name.startsWith(LIST_PREFIX);

/** An individual still able to log in or receive (as opposed to detached). */
export const isAttached = (p: StalwartPrincipal): boolean =>
  p.emails.length > 0 || !p.disabledPermissions.includes(PERM_LOGIN);

function arrayOps(field: string, current: string[], desired: string[]): { remove: PrincipalPatchOp[]; add: PrincipalPatchOp[] } {
  const cur = new Set(current);
  const want = new Set(desired);
  return {
    remove: [...cur].filter((x) => !want.has(x)).sort().map((value) => ({ action: 'removeItem' as const, field, value })),
    add: [...want].filter((x) => !cur.has(x)).sort().map((value) => ({ action: 'addItem' as const, field, value })),
  };
}

/** Managed permissions only: others present on the principal are left alone. */
function permissionOps(current: string[], desired: string[]): { remove: PrincipalPatchOp[]; add: PrincipalPatchOp[] } {
  const managed = new Set<string>(MANAGED_PERMISSIONS);
  return arrayOps('disabledPermissions', current.filter((p) => managed.has(p)), desired);
}

export interface DiffOptions {
  allowMassRemoval: boolean;
  /** Fingerprints of the secrets last pushed (when the API does not return secrets). */
  knownSecrets: Record<string, string>;
}

export function diffPrincipals(desired: DesiredPrincipals, current: CurrentPrincipals, opts: DiffOptions): PrincipalPlan {
  const plan: PrincipalPlan = { domains: [], removals: [], additions: [], domainRemovals: [], domainsKept: [], detached: [], attachedBefore: 0 };

  const haveDomains = new Set(current.domains.map((d) => d.name.toLowerCase()));
  for (const d of desired.domains) {
    if (!haveDomains.has(d)) plan.domains.push({ kind: 'create', name: d, domain: d, create: { type: 'domain', name: d } });
  }

  // ── individuals ──
  const cur = new Map(current.individuals.filter(isManagedIndividual).map((p) => [p.name.toLowerCase(), p]));
  plan.attachedBefore = [...cur.values()].filter(isAttached).length;
  for (const want of desired.individuals) {
    const fp = secretsFingerprint(want.secrets);
    const have = cur.get(want.name);
    if (!have) {
      plan.additions.push({
        kind: 'create', name: want.name, domain: want.domain, secretsFp: fp,
        create: {
          type: 'individual', name: want.name, description: want.description, emails: want.emails, secrets: want.secrets,
          quota: want.quota, roles: ['user'], disabledPermissions: want.disabled,
        },
      });
      continue;
    }
    const emails = arrayOps('emails', have.emails, want.emails);
    const perms = permissionOps(have.disabledPermissions, want.disabled);
    // Permissions are revoked (added to disabledPermissions) and addresses
    // released in the removal phase; granted / added in the addition phase.
    const removalOps: PrincipalPatchOp[] = [...emails.remove, ...perms.add];
    const additionOps: PrincipalPatchOp[] = [...emails.add, ...perms.remove];
    const haveFp = have.secrets !== undefined ? secretsFingerprint(have.secrets) : opts.knownSecrets[want.name];
    if (haveFp !== fp) additionOps.push({ action: 'set', field: 'secrets', value: want.secrets });
    if (have.quota !== want.quota) additionOps.push({ action: 'set', field: 'quota', value: want.quota });
    if (have.description !== want.description) additionOps.push({ action: 'set', field: 'description', value: want.description });
    if (!have.roles.includes('user')) additionOps.push({ action: 'addItem', field: 'roles', value: 'user' });
    if (removalOps.length) plan.removals.push({ kind: 'update', name: want.name, domain: want.domain, ops: removalOps });
    if (additionOps.length) plan.additions.push({ kind: 'update', name: want.name, domain: want.domain, ops: additionOps, secretsFp: fp });
  }
  const wanted = new Set(desired.individuals.map((i) => i.name));
  for (const [name, have] of [...cur.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (wanted.has(name)) continue;
    const ops: PrincipalPatchOp[] = [
      ...have.emails.slice().sort().map((value) => ({ action: 'removeItem' as const, field: 'emails', value })),
      ...permissionOps(have.disabledPermissions, [...MANAGED_PERMISSIONS]).add,
    ];
    const emptyFp = secretsFingerprint([]);
    const haveFp = have.secrets !== undefined ? secretsFingerprint(have.secrets) : opts.knownSecrets[name];
    if (haveFp !== emptyFp) ops.push({ action: 'set', field: 'secrets', value: [] });
    if (isAttached(have)) plan.detached.push(name);
    if (ops.length) plan.removals.push({ kind: 'update', name, domain: domainOf(name), ops, secretsFp: emptyFp });
  }
  if (!opts.allowMassRemoval && plan.detached.length > 1 && plan.detached.length * 2 > plan.attachedBefore) {
    throw new MailDriverError(
      'massRemoval',
      `stalwart: the desired state would detach ${plan.detached.length} of ${plan.attachedBefore} mailboxes — refused (force the sync to apply it)`,
    );
  }

  // ── lists (aliases, catch-alls) ──
  const curLists = new Map(current.lists.filter(isManagedList).map((p) => [p.name, p]));
  for (const want of desired.lists) {
    const have = curLists.get(want.name);
    if (!have) {
      plan.additions.push({
        kind: 'create', name: want.name, domain: want.domain,
        create: { type: 'list', name: want.name, emails: want.emails, members: want.members, externalMembers: want.externalMembers },
      });
      continue;
    }
    const emails = arrayOps('emails', have.emails, want.emails);
    const members = arrayOps('members', have.members, want.members);
    const ext = arrayOps('externalMembers', have.externalMembers, want.externalMembers);
    const removalOps = [...emails.remove, ...members.remove, ...ext.remove];
    const additionOps = [...emails.add, ...members.add, ...ext.add];
    if (removalOps.length) plan.removals.push({ kind: 'update', name: want.name, domain: want.domain, ops: removalOps });
    if (additionOps.length) plan.additions.push({ kind: 'update', name: want.name, domain: want.domain, ops: additionOps });
  }
  const wantedLists = new Set(desired.lists.map((l) => l.name));
  for (const [name, have] of [...curLists.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (wantedLists.has(name)) continue;
    const email = have.emails[0] ?? '';
    plan.removals.push({ kind: 'delete', name, domain: email.slice(email.lastIndexOf('@') + 1) || '-' });
  }

  // ── domains leaving the active set (MA10) ──
  // Every managed principal loses its addresses on such a domain in phase 2
  // (inactive-domain mailboxes, detaches, list deletions); a principal the
  // panel does not manage keeps them, so its domain is left alone (reported).
  const wantDomains = new Set(desired.domains);
  const unmanaged = [
    ...current.individuals.filter((p) => !isManagedIndividual(p)),
    ...current.lists.filter((p) => !isManagedList(p)),
  ];
  for (const d of [...current.domains].sort((a, b) => a.name.localeCompare(b.name))) {
    const name = d.name.toLowerCase();
    if (wantDomains.has(name)) continue;
    if (unmanaged.some((p) => p.emails.some((e) => e.toLowerCase().endsWith(`@${name}`)))) {
      plan.domainsKept.push(name);
      continue;
    }
    plan.domainRemovals.push({ kind: 'delete', name: d.name, domain: name });
  }
  return plan;
}

/** Number of API write calls of a plan (0 = idempotent pass). */
export const planSize = (p: PrincipalPlan): number =>
  p.domains.length + p.removals.length + p.additions.length + p.domainRemovals.length;
