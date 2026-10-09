import { AppError } from '../../middleware/errorHandler';

// ─────────────────────────────────────────────────────────────────────────────
// Pure validation rules of mail-core (docs/P4-PLAN.md §9.1): reserved local
// parts, forwarding / alias loops, autoresponder schedule. Format checks
// (LOCAL_PART_RE, MAIL_ADDRESS_RE) are done by the zod schemas of
// routes/mail.routes.ts; these rules need the account's other objects.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Local parts nobody may create: system identities of the engine and the
 * platform's own namespace. postmaster / abuse are NOT reserved (RFC 2142
 * wants them to exist: the customer creates them as mailbox or alias).
 */
const RESERVED_LOCAL_PARTS = new Set(['mailer-daemon', 'root']);
const RESERVED_PREFIX = 'oblimint';

export function isReservedLocalPart(localPart: string): boolean {
  const lp = localPart.trim().toLowerCase();
  return RESERVED_LOCAL_PARTS.has(lp) || lp.startsWith(RESERVED_PREFIX);
}

/** 400 invalidAddress for a reserved local part. */
export function assertLocalPartAllowed(localPart: string): void {
  if (isReservedLocalPart(localPart)) {
    throw new AppError(400, `"${localPart}" is reserved and cannot be used as a mail address`, 'invalidAddress', { field: 'localPart', reason: 'reserved' });
  }
}

export function splitAddress(address: string): { localPart: string; domain: string } {
  const at = address.lastIndexOf('@');
  return { localPart: address.slice(0, at), domain: address.slice(at + 1) };
}

/**
 * Delivery graph of one account: internal address → where it goes (mailbox
 * forwarding targets, alias targets). Addresses lower case.
 */
export type ForwardGraph = ReadonlyMap<string, readonly string[]>;

/**
 * Would `address` → `targets` come back to `address`, directly or through the
 * forwardings / aliases of the graph? Returns the loop path (address first and
 * last) or null. The graph entry of `address` itself is replaced by `targets`
 * (the change being validated). Bounded: every node is visited once.
 */
export function findForwardingLoop(address: string, targets: readonly string[], graph: ForwardGraph): string[] | null {
  const start = address.toLowerCase();
  const next = (node: string): readonly string[] => (node === start ? targets : graph.get(node) ?? []);
  const seen = new Set<string>();
  const stack: Array<{ node: string; path: string[] }> = targets.map((t) => ({ node: t.toLowerCase(), path: [start, t.toLowerCase()] }));
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    if (node === start) return path;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const n of next(node)) stack.push({ node: n.toLowerCase(), path: [...path, n.toLowerCase()] });
  }
  return null;
}

/** 400 forwardingLoop when findForwardingLoop finds one. */
export function assertNoForwardingLoop(address: string, targets: readonly string[], graph: ForwardGraph): void {
  const loop = findForwardingLoop(address, targets, graph);
  if (loop) throw new AppError(400, `Forwarding loop: ${loop.join(' → ')}`, 'forwardingLoop', { path: loop });
}

/**
 * Internal targets must exist: a target in one of the account's OWN mail
 * domains has to be a mailbox or an alias (else the message would bounce /
 * loop on the catch-all). Targets elsewhere (other accounts, Internet) are
 * not checked (no existence oracle on other accounts).
 */
export function assertTargetsExist(
  targets: readonly string[],
  ctx: { ownDomains: ReadonlySet<string>; existing: ReadonlySet<string>; field?: string },
): void {
  for (const t of targets) {
    const { domain } = splitAddress(t.toLowerCase());
    if (ctx.ownDomains.has(domain) && !ctx.existing.has(t.toLowerCase())) {
      throw new AppError(400, `${t} is not a mailbox or an alias of this account`, 'invalidTarget', { field: ctx.field ?? 'targets', target: t });
    }
  }
}

/** Autoresponder schedule: endsAt strictly after startsAt (both optional). 400 invalidSchedule. */
export function assertAutoresponderSchedule(startsAt: string | null | undefined, endsAt: string | null | undefined): void {
  if (!startsAt || !endsAt) return;
  const s = Date.parse(startsAt);
  const e = Date.parse(endsAt);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) {
    throw new AppError(400, 'The end of the autoresponder must be after its start', 'invalidSchedule', { field: 'endsAt' });
  }
}
